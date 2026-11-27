/**
 * Brand (dashboard/js/pages/brand.js, brand_image.js): the logo and the "use my brand colours" switch (Brand Kit Phase 1, contract §6).
 *
 * The REAL shipped files in a `node:vm` context (src/dashboard/_harness.ts) with a fake DOM and a stub `API`. What is pinned, because a
 * screenshot cannot check it:
 *
 *   - the plate rule: contract §5.2's nine vectors run through `BrandImage.plateFor`, and the colour arithmetic (`mix`, `contrast`, `readableOn`,
 *     `brandColours`) held equal to the server's own primitives (`src/services/onboarding/colour.ts`) over a grid of colours;
 *   - the pixel functions on synthetic pixels (no canvas): trim, alpha, main colour, tone, flat edges, background removal, white, the size
 *     limits, SVG sizing, and the PNG shrinking loop with a fake canvas;
 *   - who sees what: the owner edits, an operator reads with every control off and no request made, a viewer gets no page and no request;
 *   - what is sent: the upload, then the patch, key for key; a version conflict reads again and sends the SAME upload URL; removal and the
 *     switch; the server's refusals turned into the sentences of both languages;
 *   - the preview: where the logo sits in each tile and in each direction, which tiles get a plate, when the carousel signature follows a
 *     logo, the switch's colours, and that only validated hex values and finite numbers become custom properties;
 *   - hostile values in a stored `logos.main` (url, colour, size) and a hostile primary colour draw nothing and break nothing;
 *   - the shell: the route, the menu item (hidden for a viewer), both languages' keys, the stylesheet's closing braces and its logical
 *     properties, and the Help article's labels.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { contrastRatio, hexToRgb, toHex } from '../services/onboarding/colour.js';
import { FakeEl, loadDashboard, settle, type Json } from './_harness.js';

const IMAGE = 'dashboard/js/pages/brand_image.js';
const PAGE = 'dashboard/js/pages/brand.js';
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v));
const BIDI = /[⁦⁧⁨⁩​]/g;
const plain = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(BIDI, '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
/** Markup with every quoted attribute value emptied: what is left is the tags and the text, where an injected attribute or element would show. */
const bare = (markup: unknown): string => String(markup).replace(/"[^"]*"/g, '""');

// ─── Pixels ──────────────────────────────────────────────────────────────────────────────────

type Px = [number, number, number, number];
function image(width: number, height: number, at: (x: number, y: number) => Px): Json {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) data.set(at(x, y), (y * width + x) * 4);
    }
    return { data, width, height };
}
const WHITE: Px = [255, 255, 255, 255];
const NAVY: Px = [14, 59, 92, 255];
const CLEAR: Px = [0, 0, 0, 0];
const alphaOf = (img: Json, x: number, y: number): number => img.data[(y * img.width + x) * 4 + 3];

function bi(): Json {
    const h = loadDashboard({ files: [IMAGE] });
    return h.run('BrandImage');
}

// ─── The plate rule and the colour arithmetic ────────────────────────────────────────────────

describe('Brand image: the plate rule (contract §5.2)', () => {
    const B = bi();
    const logo = (alpha: boolean, tone: string, colour: string) => ({ alpha, tone, colour });
    const vectors: Array<[number, boolean, string, string, string | null, string | null]> = [
        [1, false, 'dark', '#0E3B5C', '#030B11', null],
        [2, true, 'dark', '#0E3B5C', '#030B11', '#FFFFFF'],
        [3, true, 'light', '#FFFFFF', '#030B11', null],
        [4, true, 'light', '#FFFFFF', '#F7F6F2', '#0B0B0F'],
        [5, true, 'dark', '#111111', '#F7F6F2', null],
        [6, true, 'light', '#F2A33A', '#000000', null],
        [7, true, 'dark', '#0E3B5C', null, '#FFFFFF'],
        [8, true, 'light', '#FFFFFF', null, '#0B0B0F'],
        [9, false, 'light', '#FFFFFF', null, null],
    ];
    for (const [n, alpha, tone, colour, background, expected] of vectors) {
        it(`vector ${n}: alpha ${alpha}, ${tone} ${colour} on ${background ?? 'a picture'} gives ${expected ?? 'no plate'}`, () => {
            const plate = B.plateFor(logo(alpha, tone, colour), background);
            assert.equal(plate === null ? null : plate.colour, expected);
        });
    }

    it('measures the logo against the page at 3 to 1 exactly: at 3 there is none, just under there is one', () => {
        // #767676 on white is 4.54:1, #949494 on white is 3.03:1, #959595 is 2.99:1.
        assert.ok(B.contrast('#949494', '#FFFFFF') >= 3 && B.contrast('#959595', '#FFFFFF') < 3);
        assert.equal(B.plateFor(logo(true, 'dark', '#949494'), '#FFFFFF'), null);
        assert.equal(B.plateFor(logo(true, 'dark', '#959595'), '#FFFFFF').colour, '#FFFFFF');
    });

    it('is the same constants the Mac uses', () => {
        assert.equal(B.WORDMARK_ASPECT, 2.5);
        assert.equal(B.PLATE_PADDING, 0.25);
        assert.equal(B.PLATE_RADIUS, 0.22);
        assert.equal(B.PLATE_FOR_DARK_LOGO, '#FFFFFF');
        assert.equal(B.PLATE_FOR_LIGHT_LOGO, '#0B0B0F');
        assert.equal(B.MIN_LOGO_CONTRAST, 3);
        assert.equal(B.isWordmark({ width: 250, height: 100 }), true);
        assert.equal(B.isWordmark({ width: 249, height: 100 }), false);
    });
});

describe('Brand image: colour arithmetic equals the server\'s (resolve.ts reuses colour.ts)', () => {
    const B = bi();
    const GRID = ['#000000', '#FFFFFF', '#0E3B5C', '#F2A33A', '#FFD60A', '#FFD43B', '#08080A', '#767676', '#C0392B', '#27AE60', '#3B8FD9', '#2C1654', '#F7F6F2'];

    it('contrast is colour.ts contrastRatio, and a value that is not hex reads as 1', () => {
        for (const a of GRID) for (const b of GRID) assert.equal(B.contrast(a, b), contrastRatio(a, b), `${a} on ${b}`);
        assert.equal(B.contrast('red', '#FFFFFF'), 1);
        assert.equal(B.contrast('#FFFFFF', undefined), 1);
    });

    it('mix is round(a + (b - a) k) per channel, upper case', () => {
        const mixed = (a: string, b: string, k: number): string => {
            const x = hexToRgb(a)!;
            const y = hexToRgb(b)!;
            return toHex({ r: x.r + (y.r - x.r) * k, g: x.g + (y.g - x.g) * k, b: x.b + (y.b - x.b) * k });
        };
        for (const a of GRID) for (const k of [0, 0.18, 0.25, 0.5, 0.82, 1]) assert.equal(B.mix(a, '#000000', k), mixed(a, '#000000', k), `${a} → black ${k}`);
        assert.equal(B.mix('#0E3B5C', '#FFFFFF', 0), '#0E3B5C');
    });

    it('readableOn is the first step toward white (2.5% each, up to 40) that reaches the minimum, else white', () => {
        const spec = (colour: string, background: string, min = 4.5): string => {
            for (let i = 0; i <= 40; i++) {
                const x = hexToRgb(colour)!;
                const next = toHex({ r: x.r + (255 - x.r) * i * 0.025, g: x.g + (255 - x.g) * i * 0.025, b: x.b + (255 - x.b) * i * 0.025 });
                if (contrastRatio(next, background) >= min) return next;
            }
            return '#FFFFFF';
        };
        for (const c of GRID) for (const bg of ['#030B11', '#08080A', '#000000']) assert.equal(B.readableOn(c, bg), spec(c, bg), `${c} on ${bg}`);
        const dark = B.readableOn('#0E3B5C', '#08080A');
        assert.ok(contrastRatio(dark, '#08080A') >= 4.5, 'a dark colour is lifted until it reads');
        assert.equal(B.readableOn('#0E3B5C', '#FFFFFF', 22), '#FFFFFF', 'when nothing reaches it, white');
        assert.equal(B.readableOn('#F2A33A', '#000000'), '#F2A33A', 'one that already reads is unchanged');
    });

    it('brandColours gives the neutral defaults\' example of contract §3.1, and falls back for a value that is not hex', () => {
        assert.deepEqual(json(B.brandColours('#0E3B5C', '#F2A33A')), { carouselInk: '#030B11', carouselAccent: '#F2A33A', reelAccent: '#F2A33A', explainerTitle: '#F2A33A' });
        assert.deepEqual(json(B.brandColours('nope', 12)), json(B.brandColours('#0E3B5C', '#F2A33A')));
        assert.deepEqual(json(B.brandColours('#abcdef', '#f2a33a')), json(B.brandColours('#ABCDEF', '#F2A33A')), 'lower case is read');
    });

    it('tone: light above 0.179 of relative luminance', () => {
        assert.equal(B.tone('#FFFFFF'), 'light');
        assert.equal(B.tone('#F2A33A'), 'light');
        assert.equal(B.tone('#0E3B5C'), 'dark');
        assert.equal(B.tone('#111111'), 'dark');
        assert.equal(B.tone('nope'), 'dark');
    });
});

// ─── The pure pixel functions ────────────────────────────────────────────────────────────────

describe('Brand image: trim, alpha, colour, edges', () => {
    const B = bi();

    it('trims a transparent image to the pixels with alpha of at least 16', () => {
        const img = image(10, 8, (x, y) => (x >= 2 && x <= 5 && y >= 1 && y <= 3 ? NAVY : (x === 9 && y === 7 ? [0, 0, 0, 15] : CLEAR)));
        assert.deepEqual(json(B.trimBounds(img)), { x: 2, y: 1, width: 4, height: 3 }, 'alpha 15 is not in the logo');
        assert.equal(B.trimBounds(image(4, 4, () => CLEAR)), null, 'nothing in it');
    });

    it('trims an opaque image to the pixels that differ from the top-left one by more than 12 in some channel', () => {
        const img = image(10, 8, (x, y) => (x >= 3 && x <= 4 && y >= 2 && y <= 6 ? NAVY : (x === 0 && y === 7 ? [250, 250, 255, 255] : WHITE)));
        assert.deepEqual(json(B.trimBounds(img)), { x: 3, y: 2, width: 2, height: 5 }, 'a pixel 5 away from white is the background');
        assert.equal(B.trimBounds(image(3, 3, () => WHITE)), null);
    });

    it('hasAlpha: some pixel under 250', () => {
        assert.equal(B.hasAlpha(image(2, 2, () => WHITE)), false);
        assert.equal(B.hasAlpha(image(2, 2, (x) => (x ? [1, 2, 3, 249] : WHITE))), true);
        assert.equal(B.hasAlpha(image(2, 2, (x) => (x ? [1, 2, 3, 250] : WHITE))), false);
    });

    it('mainColour: the most frequent 4-bit bucket, averaged, ignoring alpha under 128', () => {
        const img = image(10, 10, (x) => (x < 6 ? [200, 20, 20, 255] : (x < 9 ? [10, 10, 200, 255] : [0, 255, 0, 127])));
        assert.equal(B.mainColour(img), '#C81414');
        const shared = image(4, 1, (x) => (x < 2 ? [16, 16, 16, 255] : [31, 31, 31, 255]));
        assert.equal(B.mainColour(shared), '#181818', '16 and 31 share the bucket 1,1,1: its pixels are averaged');
        const tie = image(4, 1, (x) => (x < 2 ? [200, 20, 20, 255] : [16, 16, 16, 255]));
        assert.equal(B.mainColour(tie), '#101010', 'two buckets of the same size: the lowest one wins');
        assert.equal(B.mainColour(image(2, 2, () => CLEAR)), '#000000', 'no opaque pixel');
    });

    it('flatEdges: the share of border pixels within 24 of the top-left colour', () => {
        const flat = image(10, 10, (x, y) => (x >= 3 && x <= 6 && y >= 3 && y <= 6 ? NAVY : WHITE));
        assert.equal(B.flatEdges(flat), 1);
        const half = image(10, 10, (x, y) => (y === 0 || x === 0 || x === 9 || y === 9 ? (x < 5 ? WHITE : NAVY) : WHITE));
        assert.ok(B.flatEdges(half) < B.EDGE_FLAT);
        assert.equal(B.measure(flat).flat, true);
        assert.equal(B.measure(image(4, 4, (x) => (x ? CLEAR : NAVY))).flat, false, 'a transparent logo has no background to lift');
    });
});

describe('Brand image: remove the background, make it white', () => {
    const B = bi();
    // A white page, a navy ring with a white hole in it, and a white island that is NOT connected to the border.
    const ring = (x: number, y: number): Px => {
        const inRing = x >= 2 && x <= 9 && y >= 2 && y <= 9 && !(x >= 4 && x <= 7 && y >= 4 && y <= 7);
        return inRing ? NAVY : WHITE;
    };
    const img = image(12, 12, ring);

    it('clears what is connected to the border and keeps the hole inside the ring, then trims', () => {
        const out = B.removeBackground(img, 24);
        assert.equal(out.width, 8);
        assert.equal(out.height, 8);
        assert.equal(alphaOf(out, 0, 0), 255, 'the ring');
        assert.equal(alphaOf(out, 3, 3), 255, 'the white hole is not connected to the border, so it stays');
        assert.equal(B.hasAlpha(out), false, 'once trimmed to the ring nothing outside is left');
    });

    it('leaves the source image alone', () => {
        const before = Array.from(img.data as Uint8ClampedArray);
        B.removeBackground(img, 24);
        assert.deepEqual(Array.from(img.data as Uint8ClampedArray), before);
    });

    it('turns the background transparent where the logo does not fill the frame (a tolerance that matters)', () => {
        const soft = image(10, 10, (x, y) => (x >= 3 && x <= 6 && y >= 3 && y <= 6 ? NAVY : (x === 0 || y === 0 ? [235, 235, 235, 255] : WHITE)));
        const tight = B.removeBackground(soft, 0);
        const loose = B.removeBackground(soft, 24);
        assert.ok(tight.width > loose.width, 'with tolerance 0 the grey edge row is not the background, so it is kept');
        assert.equal(loose.width, 4);
        assert.equal(loose.height, 4);
    });

    it('answers null when nothing is left', () => {
        assert.equal(B.removeBackground(image(6, 6, () => WHITE), 24), null);
    });

    it('whiten: every pixel with alpha becomes white, alpha kept, a copy', () => {
        const src = image(2, 1, (x) => (x ? CLEAR : [14, 59, 92, 130]));
        const out = B.whiten(src);
        assert.deepEqual(Array.from(out.data as Uint8ClampedArray), [255, 255, 255, 130, 0, 0, 0, 0]);
        assert.deepEqual(Array.from(src.data as Uint8ClampedArray).slice(0, 4), [14, 59, 92, 130]);
    });
});

describe('Brand image: sizes, SVG, the PNG', () => {
    const B = bi();

    it('checkSize: the short side needs 200 and the shape 1 to 4 .. 8 to 1', () => {
        assert.deepEqual(json(B.checkSize(199, 400)), { code: 'tooSmall', params: { px: 199 } });
        assert.equal(B.checkSize(200, 200), null);
        assert.equal(B.checkSize(1600, 200), null, '8 to 1 is allowed');
        assert.deepEqual(json(B.checkSize(1601, 200)), { code: 'badShape' });
        assert.deepEqual(json(B.checkSize(200, 801)), { code: 'badShape' });
        assert.equal(B.checkSize(200, 800), null, '1 to 4 is allowed');
    });

    it('svgDimensions: width and height, else the viewBox, long side 2048; none is null', () => {
        assert.deepEqual(json(B.svgDimensions('100', '50', null)), { w: 2048, h: 1024 });
        assert.deepEqual(json(B.svgDimensions('100px', '200px', null)), { w: 1024, h: 2048 });
        assert.deepEqual(json(B.svgDimensions(null, null, '0 0 300 300')), { w: 2048, h: 2048 });
        assert.deepEqual(json(B.svgDimensions('100%', '100%', '0 0 40 20')), { w: 2048, h: 1024 }, 'a percentage is not a size: the viewBox is');
        assert.equal(B.svgDimensions(null, null, null), null);
        assert.equal(B.svgDimensions('0', '0', '0 0 0 0'), null);
    });

    it('scaleFor and logoBox: capped at 1600, contained, never stretched', () => {
        assert.equal(B.scaleFor(1600, 400), 1);
        assert.equal(B.scaleFor(3200, 800), 0.5);
        assert.deepEqual(json(B.logoBox({ width: 1200, height: 400 }, 52, 340)), { width: 156, height: 52 });
        assert.deepEqual(json(B.logoBox({ width: 1500, height: 250 }, 52, 340)), { width: 312, height: 52 });
        assert.deepEqual(json(B.logoBox({ width: 2000, height: 250 }, 52, 340)), { width: 340, height: 43 }, 'wider than the box: exactly the box wide');
        for (const row of [[56, 440], [48, 320], [52, 340], [56, 360], [54, 400], [120, 560]] as const) {
            const box = B.logoBox({ width: 8000, height: 1000 }, row[0], row[1]);
            assert.ok(box.height >= 40, `an 8:1 logo stays at least 40 px tall in a ${row[1]}-wide box (${box.height})`);
        }
    });

    it('toPng: caps the long side, shrinks by 0.8 while over 3,000,000 bytes, and gives up below a 200 px short side', () => {
        const fake = (w: number, h: number, bytesFor: (w: number, h: number) => number, log?: number[][]): Json => ({
            width: w, height: h,
            getContext: () => ({ drawImage: () => {}, imageSmoothingQuality: '' }),
            toDataURL: () => { const b = bytesFor(w, h); log?.push([w, h]); return `data:image/png;base64,${'A'.repeat(Math.ceil(b / 3) * 4)}`; },
        });
        const sizes: number[][] = [];
        const make = (w: number, h: number): Json => fake(w, h, (cw, ch) => cw * ch * 4, sizes);
        const out = B.toPng(fake(3000, 1000, (w, h) => w * h * 4), { makeCanvas: make });
        assert.ok(out.bytes <= 3000000 && out.width < 1600 && out.width >= 200, JSON.stringify(out.bytes));
        assert.equal(Math.round((out.width / out.height) * 10), 30, 'the shape is kept');
        assert.ok(sizes.length >= 2 && sizes[0]![0] === 1600, 'first at the cap, then smaller');
        const light = B.toPng(fake(800, 400, () => 1234), { makeCanvas: make });
        assert.deepEqual([light.width, light.height], [800, 400], 'under the cap and the limit: as it is');
        assert.equal(light.bytes, 1236, 'the bytes of the base64 the canvas gave');
        assert.throws(() => B.toPng(fake(1000, 500, () => 5000000), { makeCanvas: (w: number, h: number) => fake(w, h, () => 5000000) }), (err: Json) => err.logoCode === 'tooBig');
    });

    it('base64Bytes counts the padding', () => {
        assert.equal(B.base64Bytes('AAAA'), 3);
        assert.equal(B.base64Bytes('AAA='), 2);
        assert.equal(B.base64Bytes('AA=='), 1);
    });

    it('load refuses a file over 10 MB and a type it does not read, before reading either', async () => {
        await assert.rejects(() => B.load({ size: 10 * 1024 * 1024 + 1, type: 'image/png', name: 'a.png' }), (err: Json) => err.logoCode === 'fileTooBig');
        await assert.rejects(() => B.load({ size: 10, type: 'application/pdf', name: 'a.pdf' }), (err: Json) => err.logoCode === 'unreadable');
        await assert.rejects(() => B.load(null), (err: Json) => err.logoCode === 'unreadable');
    });
});

// ─── The page ────────────────────────────────────────────────────────────────────────────────

const refusal = (status: number, code: string, body: Json = {}): Error => Object.assign(new Error(`server says ${code}`), { status, code, body: { code, ...body } });
const LOGO = { url: 'https://msg-response-auto.vercel.app/api/uploads/6f1c2a90-3b7e-4d21-9a55-0c8e7d4b1f23', width: 1200, height: 400, alpha: true, tone: 'dark', colour: '#0E3B5C', added_at: '2026-12-01T09:30:00.000Z' };
const profileOf = (brand: Json = {}): Json => ({
    brand: { primary: '#0E3B5C', accent: '#F2A33A', font_display: 'Cairo', logo_url: null, portrait_url: null, theme: 'dark', ...brand },
});
const SETTINGS = { settings: { brand: { colors: { ink: '#08080A', paper: '#FAFAFA', muted: '#8A8A93' }, palette: ['#FFD60A', '#FF5A5F'] }, explainer: { title_color: '#FFD43B' } } };

interface Rig {
    h: ReturnType<typeof loadDashboard>;
    P: Json;
    container: Json;
    cards: { logo: Json; colours: Json; preview: Json };
    calls: Array<{ method: string; args: Json[] }>;
    toasts: string[];
    confirms: Json[];
    api: Record<string, (...args: Json[]) => unknown>;
}

function rig(options: { lang?: 'ar' | 'en'; role?: 'owner' | 'operator' | 'viewer'; profile?: Json; version?: number | null; settings?: Json | Error } = {}): Rig {
    const role = options.role ?? 'owner';
    const calls: Rig['calls'] = [];
    const state = { profile: options.profile ?? profileOf(), version: options.version === undefined ? 4 : options.version, stored: true };
    const api: Rig['api'] = {
        getProfile: async () => json(state),
        getStudioSettings: async () => { if (options.settings instanceof Error) throw options.settings; return json(options.settings ?? SETTINGS); },
        uploadMedia: async () => ({ id: 'u1', url: LOGO.url }),
        patchProfile: async (_version: number, patch: Json) => ({ profile: { ...state.profile, brand: { ...state.profile.brand, ...(patch.brand.use_brand_colours !== undefined ? { use_brand_colours: patch.brand.use_brand_colours } : {}), logos: patch.brand.logos ? (patch.brand.logos.main === null ? {} : patch.brand.logos) : state.profile.brand.logos } }, version: (state.version ?? 0) + 1, stored: true }),
    };
    const API = new Proxy(api, {
        get: (target, prop: string) => (prop === 'token' ? 'tok' : (...args: Json[]) => {
            calls.push({ method: prop, args: json(args) });
            if (!(prop in target)) return Promise.reject(new Error(`API.${prop} is not stubbed`));
            return target[prop]!(...args);
        }),
    });
    const App = { currentPage: 'brand', canAdminister: () => role === 'owner', canOperate: () => role !== 'viewer', loadPageModule: async () => null };
    const h = loadDashboard({ lang: options.lang ?? 'en', files: [IMAGE, PAGE], globals: { API, App } });
    const toasts: string[] = [];
    const confirms: Json[] = [];
    h.UI.toast = (message: string): void => { toasts.push(String(message)); };
    h.UI.confirm = (o: Json): void => { confirms.push(o); };
    return {
        h, P: h.run('BrandPage'), container: h.el('page-container'),
        cards: { logo: h.el('brand-logo-card'), colours: h.el('brand-colours-card'), preview: h.el('brand-preview-card') },
        calls, toasts, confirms, api,
    };
}

async function opened(options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
    const r = rig(options);
    await r.P.render();
    await settle();
    return r;
}

/** A prepared logo, as `chooseFile` leaves it. */
const draftOf = (over: Json = {}): Json => ({
    canvas: {}, history: [], bgBase: null, tolerance: 24,
    stats: { width: 1200, height: 400, alpha: true, colour: '#0E3B5C', tone: 'dark', flat: false },
    problem: null, png: { base64: 'QUJD', bytes: 3, width: 1200, height: 400 }, ...over,
});

describe('Brand page: who sees what', () => {
    it('shows the owner the logo card, the switch and the preview, with the controls on', async () => {
        const r = await opened();
        const markup = String(r.container.innerHTML);
        const text = plain(markup);
        assert.ok(text.includes('No logo yet. Nothing changes on your posts until you add one.'));
        assert.ok(text.includes('Choose a logo'));
        assert.match(markup, /id="brand-file"[^>]*data-change="brand:file"/);
        assert.equal(/id="brand-file"[^>]*disabled/.test(markup), false);
        assert.match(markup, /id="brand-colours-switch"/);
        assert.equal(/id="brand-colours-switch"[^>]*disabled/.test(markup), false);
        assert.equal(/id="brand-colours-switch"[^>]*checked/.test(markup), false, 'a profile without the key reads as off');
        assert.equal((markup.match(/data-bp-tile="/g) ?? []).length, 5, 'five tiles');
        assert.equal(r.container.innerHTML.includes('brand-readonly'), false);
        assert.deepEqual(r.calls.map((c) => c.method).sort(), ['getProfile', 'getStudioSettings']);
    });

    it('shows an operator the page read only: the note, every control off, and no request when they try', async () => {
        const r = await opened({ role: 'operator', profile: profileOf({ logos: { main: LOGO }, use_brand_colours: true }) });
        const markup = String(r.container.innerHTML);
        assert.ok(plain(markup).includes('Only the workspace owner can change the brand.'));
        assert.match(markup, /id="brand-colours-switch"[^>]*checked[^>]*disabled|id="brand-colours-switch"[^>]*disabled[^>]*checked/);
        assert.equal(markup.includes('data-change="brand:file"'), false, 'no file chooser');
        assert.match(markup, /<button type="button" class="btn btn-secondary" disabled>/);
        assert.match(markup, /id="brand-remove"[^>]*disabled|disabled[^>]*id="brand-remove"/);
        const before = r.calls.length;
        r.P.remove();
        await r.P.setColours(false, { checked: true });
        await r.P.chooseFile({ size: 1, type: 'image/png', name: 'a.png' });
        r.P.draft = draftOf();
        await r.P.save();
        assert.equal(r.confirms.length, 0, 'no question to confirm');
        assert.equal(r.calls.length, before, 'no request at all');
    });

    it('gives a viewer no page and asks for nothing', async () => {
        const r = await opened({ role: 'viewer' });
        assert.ok(plain(r.container.innerHTML).includes('Your role cannot open this page.'));
        assert.deepEqual(r.calls, []);
    });

    it('treats the server\'s 403 the same way', async () => {
        const r = rig();
        r.api.getProfile = async () => { throw refusal(403, 'FORBIDDEN'); };
        await r.P.render();
        assert.ok(plain(r.container.innerHTML).includes('Your role cannot open this page.'));
    });

    it('shows a failure with Retry, and the Arabic page in Arabic', async () => {
        const r = rig();
        r.api.getProfile = async () => { throw new Error('boom'); };
        let shown: Json = null;
        r.h.UI.renderError = (_c: unknown, o: Json): void => { shown = o; };
        await r.P.render();
        assert.equal(shown.title, 'The brand could not be loaded.');
        const ar = await opened({ lang: 'ar' });
        const text = plain(ar.container.innerHTML);
        assert.ok(text.includes('اختر شعارًا') && text.includes('أين يظهر شعارك') && text.includes('ألوان هويتك'));
    });

    it('still opens when the Studio settings did not load: the preview uses the Studio\'s own defaults', async () => {
        const r = await opened({ settings: new Error('down') });
        assert.equal((String(r.container.innerHTML).match(/data-bp-tile="/g) ?? []).length, 5);
        const ctx = r.P.previewContext();
        assert.equal(ctx.ink, '#08080A');
        assert.equal(ctx.carouselAccent, '#FFD60A');
        assert.equal(ctx.explainerTitle, '#FFD43B');
    });
});

describe('Brand page: the saved logo', () => {
    it('shows it on a dark and a light page with its facts, Replace and Remove', async () => {
        const r = await opened({ profile: profileOf({ logos: { main: LOGO } }) });
        const markup = String(r.container.innerHTML);
        const text = plain(markup);
        assert.ok(text.includes('On a dark page') && text.includes('On a light page'));
        assert.ok(text.includes('PNG · 1200×400 · transparent background'));
        assert.ok(text.includes('Replace logo') && text.includes('Remove logo'));
        assert.equal(text.includes('Save logo'), false, 'nothing to save');
        assert.ok(markup.includes(`src="${LOGO.url}"`));
        assert.equal(text.includes('No logo yet'), false);
    });

    it('reads a solid-background logo as such', async () => {
        const r = await opened({ profile: profileOf({ logos: { main: { ...LOGO, alpha: false } } }) });
        assert.ok(plain(r.container.innerHTML).includes('PNG · 1200×400 · solid background'));
    });

    it('asks before removing, then sends the null and says so', async () => {
        const r = await opened({ profile: profileOf({ logos: { main: LOGO } }) });
        r.P.remove();
        assert.equal(r.confirms.length, 1);
        assert.equal(r.confirms[0].body, 'Remove your logo? New posts are made without it; posts already made keep it.');
        assert.equal(r.calls.filter((c) => c.method === 'patchProfile').length, 0, 'nothing is sent before yes');
        await r.confirms[0].onConfirm();
        const patch = r.calls.find((c) => c.method === 'patchProfile')!;
        assert.deepEqual(patch.args, [4, { brand: { logos: { main: null } } }]);
        assert.ok(r.toasts.includes('Logo removed.'));
        assert.equal(r.P.savedLogo(r.P.profile), null);
    });
});

describe('Brand page: saving a logo', () => {
    it('uploads the PNG, then patches exactly the six fields, with the version the page read', async () => {
        const r = await opened();
        r.P.draft = draftOf();
        await r.P.save();
        const names = r.calls.map((c) => c.method);
        assert.deepEqual(names.slice(2), ['uploadMedia', 'patchProfile']);
        assert.deepEqual(r.calls[2]!.args, [{ filename: 'logo.png', mime_type: 'image/png', base64_data: 'QUJD' }]);
        assert.deepEqual(r.calls[3]!.args, [4, { brand: { logos: { main: { url: LOGO.url, width: 1200, height: 400, alpha: true, tone: 'dark', colour: '#0E3B5C' } } } }]);
        assert.deepEqual(Object.keys((r.calls[3]!.args[1] as Json).brand.logos.main), ['url', 'width', 'height', 'alpha', 'tone', 'colour']);
        assert.equal(r.P.draft, null);
        assert.equal(r.P.canLeave(), true);
        assert.ok(r.toasts.includes('Logo saved. New posts will show it.'));
        assert.equal(r.P.version, 5, 'the next save carries the version this one made');
    });

    it('a version conflict reads the profile again and sends the SAME upload URL once more', async () => {
        const r = await opened();
        let first = true;
        r.api.patchProfile = async (version: number, patch: Json) => {
            if (first) { first = false; throw refusal(409, 'PROFILE_VERSION_CONFLICT', { currentVersion: 9 }); }
            return { profile: profileOf({ logos: patch.brand.logos }), version: version + 1, stored: true };
        };
        r.api.getProfile = async () => ({ profile: profileOf(), version: 9, stored: true });
        r.P.draft = draftOf();
        await r.P.save();
        const patches = r.calls.filter((c) => c.method === 'patchProfile');
        assert.equal(patches.length, 2);
        assert.equal(patches[0]!.args[0], 4);
        assert.equal(patches[1]!.args[0], 9, 'the version it read');
        assert.deepEqual(patches[1]!.args[1], patches[0]!.args[1], 'the same patch');
        assert.equal(r.calls.filter((c) => c.method === 'uploadMedia').length, 1, 'the file is not uploaded again');
        assert.equal(r.P.draft, null);
    });

    it('a second conflict is shown, not retried forever', async () => {
        const r = await opened();
        r.api.patchProfile = async () => { throw refusal(409, 'PROFILE_VERSION_CONFLICT'); };
        r.P.draft = draftOf();
        await r.P.save();
        assert.equal(r.calls.filter((c) => c.method === 'patchProfile').length, 2);
        assert.ok(r.P.draft, 'the draft is kept so nothing is lost');
        assert.ok(r.P.errors.logo.length > 0);
    });

    it('turns each refusal into the sentence of the interface language', async () => {
        const en = rig();
        const ar = rig({ lang: 'ar' });
        const invalid = (code: string): Error => refusal(400, 'BRAND_LOGO_INVALID', { problems: [code] });
        const cases: Array<[Error, string, string]> = [
            [invalid('logo.not_png'), 'The file is not a PNG. Choose it again.', 'الملف ليس بصيغة PNG. اختره مرة أخرى.'],
            [invalid('logo.not_found'), 'The uploaded file was not found. Choose it again.', 'لم يُعثر على الملف المرفوع. اختره مرة أخرى.'],
            [invalid('logo.not_yours'), 'That file belongs to another workspace.', 'هذا الملف يخص مساحة عمل أخرى.'],
            [invalid('logo.private'), 'That file cannot be used as a logo.', 'لا يمكن استخدام هذا الملف شعارًا.'],
            [invalid('logo.too_big'), 'The file is over 3 MB.', 'حجم الملف أكبر من 3 ميجابايت.'],
            [invalid('logo.too_small'), 'The logo is smaller than 200 px on its short side.', 'الشعار أصغر من 200 بكسل في ضلعه الأقصر.'],
            [invalid('logo.too_large'), 'The logo is larger than 4096 px.', 'الشعار أكبر من 4096 بكسل.'],
            [invalid('logo.aspect'), 'Too long or too tall to show clearly (more than 8 to 1).', 'أطول أو أعلى من أن يظهر بوضوح (أكثر من 8 إلى 1).'],
            [refusal(503, 'BRAND_LOGO_UNREADABLE', { problems: ['logo.unreadable'] }), 'We couldn\'t read your logo just now. Try again in a minute.', 'تعذّرت قراءة الشعار الآن. أعد المحاولة بعد دقيقة.'],
        ];
        for (const [err, english, arabic] of cases) {
            assert.equal(en.P.errorText(err), english, String(err.message));
            assert.equal(ar.P.errorText(err), arabic, String(err.message));
        }
        const other = Object.assign(new Error('The server said something else'), { status: 500 });
        assert.equal(en.P.errorText(other), 'The server said something else', 'anything else: the server\'s own text');
        const shape = refusal(400, 'BRAND_LOGO_INVALID', { problems: ['brand.logos.main.url must be one of your uploads'] });
        assert.equal(en.P.errorText(shape), 'server says BRAND_LOGO_INVALID', 'a shape problem has no code: the server\'s text');
    });

    it('shows the error under the card and keeps Save available for another try', async () => {
        const r = await opened();
        r.api.uploadMedia = async () => { throw refusal(503, 'BRAND_LOGO_UNREADABLE'); };
        r.P.draft = draftOf();
        await r.P.save();
        assert.ok(plain(r.cards.logo.innerHTML).includes('We couldn\'t read your logo just now.'));
        assert.match(String(r.cards.logo.innerHTML), /id="brand-save"/);
        assert.equal(/id="brand-save"[^>]*disabled/.test(String(r.cards.logo.innerHTML)), false);
    });

    it('will not save a draft with a problem, and says why', async () => {
        const r = await opened();
        r.P.draft = draftOf({ png: null, problem: { code: 'tooSmall', params: { px: 120 } }, stats: { width: 120, height: 400, alpha: true, colour: '#0E3B5C', tone: 'dark', flat: false } });
        r.P.errors.logo = r.h.t('brand.logo.tooSmall', { px: 120 });
        await r.P.save();
        assert.equal(r.calls.filter((c) => c.method === 'uploadMedia').length, 0);
        r.P.repaint('logo');
        assert.ok(plain(r.cards.logo.innerHTML).includes('Too small: the short side is 120 px; it needs at least 200.'));
        assert.match(String(r.cards.logo.innerHTML), /id="brand-save"[^>]*disabled/);
    });

    it('holds the page while a prepared logo is unsaved: canLeave is false, and discardChanges lets it go', async () => {
        const r = await opened();
        assert.equal(r.P.canLeave(), true);
        r.P.draft = draftOf();
        assert.equal(r.P.canLeave(), false);
        r.P.discardChanges();
        assert.equal(r.P.canLeave(), true);
    });

    it('shows the draft on the swatches, says it is not saved, and offers the tools that fit it', async () => {
        const r = await opened();
        r.P.draft = draftOf({ stats: { width: 800, height: 400, alpha: false, colour: '#0E3B5C', tone: 'dark', flat: true }, png: { base64: 'QUJD', bytes: 3, width: 800, height: 400 } });
        r.P.repaint('logo');
        const markup = String(r.cards.logo.innerHTML);
        const text = plain(markup);
        assert.ok(text.includes('Not saved yet. Press Save logo to use it.'));
        assert.ok(text.includes('This logo sits on a plain background.'));
        assert.ok(text.includes('PNG · 800×400 · solid background'));
        assert.match(markup, /data-action="brand:removeBg"/);
        assert.match(markup, /id="brand-tol"/);
        assert.equal(markup.includes('brand:whiten'), false, 'an opaque logo cannot be made white');
        assert.match(markup, /src="data:image\/png;base64,QUJD"/);
        r.P.draft = draftOf();
        r.P.repaint('logo');
        const clear = String(r.cards.logo.innerHTML);
        assert.match(clear, /data-action="brand:whiten"/);
        assert.equal(clear.includes('brand:removeBg'), false, 'a transparent logo has no background to remove');
    });
});

describe('Brand page: the colours switch', () => {
    it('sends only the flag, with the version, and says so', async () => {
        const r = await opened();
        await r.P.setColours(true, { checked: true });
        const patch = r.calls.find((c) => c.method === 'patchProfile')!;
        assert.deepEqual(patch.args, [4, { brand: { use_brand_colours: true } }]);
        assert.ok(r.toasts.includes('Brand colours on.'));
        assert.equal(r.P.coloursOn(r.P.profile), true);
        await r.P.setColours(false, { checked: false });
        assert.deepEqual(r.calls.filter((c) => c.method === 'patchProfile')[1]!.args, [5, { brand: { use_brand_colours: false } }]);
        assert.ok(r.toasts.includes('Brand colours off.'));
    });

    it('puts the switch back and says why when the save fails', async () => {
        const r = await opened();
        r.api.patchProfile = async () => { throw new Error('nope'); };
        const input = { checked: true };
        await r.P.setColours(true, input);
        assert.equal(input.checked, false);
        assert.equal(r.P.errors.colours, 'nope');
        assert.equal(r.P.coloursOn(r.P.profile), false);
    });

    it('reads an absent key as off, and only `true` as on', () => {
        const r = rig();
        for (const v of [undefined, false, 'true', 1, null]) assert.equal(r.P.coloursOn(profileOf(v === undefined ? {} : { use_brand_colours: v })), false);
        assert.equal(r.P.coloursOn(profileOf({ use_brand_colours: true })), true);
    });

    it('names what it changes and links the page where the colours are set', async () => {
        const r = await opened();
        const markup = String(r.cards.colours.innerHTML || r.container.innerHTML);
        const text = plain(markup);
        assert.ok(text.includes('Use my brand colours on carousels, reels and explainer titles'));
        assert.ok(text.includes('Carousels and reels made before keep their own accent.'));
        assert.ok(text.includes('Your main colour and accent are set on the Infographics page.'));
        assert.match(markup, /href="#\/infographics"/);
        assert.match(markup, /href="#\/help\/brand"/);
    });
});

describe('Brand page: the preview', () => {
    const logoOf = (over: Json = {}): Json => ({ url: LOGO.url, width: 1200, height: 400, alpha: true, tone: 'dark', colour: '#0E3B5C', ...over });
    const model = (r: Rig, key: string, ctxOver: Json, lang: 'ar' | 'en'): Json => {
        const tile = r.P.TILES.find((x: Json) => x.key === key);
        const ctx = { ...r.P.previewContext(), ...ctxOver };
        return json(r.P.tileModel(tile, ctx, lang));
    };

    it('has the five tiles at the numbers of contract §5.3', () => {
        const r = rig();
        assert.deepEqual(json(r.P.TILES.map((x: Json) => [x.key, x.w, x.h, x.logoH, x.maxW])), [
            ['carousel', 1080, 1350, 52, 340], ['carouselTikTok', 1080, 1920, 56, 360], ['infographic', 1080, 1350, 48, 320], ['explainer', 1080, 1920, 56, 440], ['reel', 1080, 1920, 120, 560],
        ]);
    });

    it('starts at the start edge: the right in Arabic and the left in English, with the TikTok box\'s own insets', () => {
        const r = rig();
        const ctx = { logo: logoOf({ alpha: false }), ink: '#030B11' };
        assert.equal(model(r, 'carousel', ctx, 'ar').start, 92);
        assert.equal(model(r, 'carousel', ctx, 'en').start, 92);
        assert.equal(model(r, 'carouselTikTok', ctx, 'ar').start, 150, 'TikTok\'s buttons are on the right, so the Arabic start is the wide one');
        assert.equal(model(r, 'carouselTikTok', ctx, 'en').start, 84);
        assert.equal(model(r, 'infographic', ctx, 'ar').start, 40);
        assert.equal(model(r, 'explainer', ctx, 'ar').centre, true);
        assert.equal(model(r, 'reel', ctx, 'en').centre, true);
        assert.equal(model(r, 'carousel', ctx, 'ar').dir, 'rtl');
        assert.equal(model(r, 'carousel', ctx, 'en').dir, 'ltr');
    });

    it('centres a header logo on its row and puts the explainer and the reel by their top edge', () => {
        const r = rig();
        const ctx = { logo: logoOf({ alpha: false }) };
        const carousel = model(r, 'carousel', ctx, 'ar');
        assert.equal(carousel.top, 100 - carousel.outerH / 2, 'centred on the row at y 100');
        assert.equal(model(r, 'explainer', ctx, 'ar').top, 1640);
        assert.equal(model(r, 'reel', ctx, 'ar').top, 270);
    });

    it('gives a plate where the rule says: a dark transparent mark on a dark page and always over the video, none for an opaque one', async () => {
        const r = await opened();
        const ctx = { logo: logoOf() };
        const carousel = model(r, 'carousel', { ...ctx, ink: '#030B11' }, 'ar');
        assert.equal(carousel.plate, '#FFFFFF');
        assert.equal(carousel.pad, Math.round(0.25 * carousel.drawn.height), 'the padding is a quarter of the logo\'s height');
        assert.equal(carousel.outerH, carousel.drawn.height + 2 * carousel.pad);
        assert.equal(carousel.radius, Math.round(0.22 * carousel.outerH));
        assert.equal(carousel.shadow, false, 'a page behind it: no shadow');
        const reel = model(r, 'reel', ctx, 'ar');
        assert.equal(reel.plate, '#FFFFFF');
        assert.equal(reel.shadow, true, 'over a video the plate has its soft shadow');
        const opaque = model(r, 'reel', { logo: logoOf({ alpha: false }) }, 'ar');
        assert.equal(opaque.plate, null);
        assert.equal(opaque.shadow, false);
        const white = model(r, 'carousel', { logo: logoOf({ tone: 'light', colour: '#FFFFFF' }), ink: '#030B11' }, 'ar');
        assert.equal(white.plate, null, 'a white mark reads on a dark page');
    });

    it('tells under a tile when it gets a plate', async () => {
        const r = await opened({ profile: profileOf({ logos: { main: LOGO } }) });
        const markup = String(r.container.innerHTML);
        const preview = markup.slice(markup.indexOf('brand-preview-card'));
        assert.ok(plain(preview).includes('A small plate is added behind the logo here, so it stays visible.'));
        const none = await opened({ profile: profileOf({ logos: { main: { ...LOGO, alpha: false } } }) });
        assert.equal(plain(String(none.container.innerHTML).slice(String(none.container.innerHTML).indexOf('brand-preview-card'))).includes('A small plate is added'), false);
    });

    it('lets the carousel signature follow a narrow logo (gap 18), and hides it behind a wordmark', () => {
        const r = rig();
        const mark = model(r, 'carousel', { logo: logoOf({ width: 600, height: 600, alpha: false }) }, 'ar');
        assert.equal(mark.wordmark, false);
        assert.equal(mark.sigStart, mark.start + mark.outerW + 18);
        const word = model(r, 'carousel', { logo: logoOf({ width: 1500, height: 250, alpha: false }) }, 'ar');
        assert.equal(word.wordmark, true);
        assert.equal(word.sigStart, null, 'a wordmark already says the name');
        const none = model(r, 'carousel', { logo: null }, 'ar');
        assert.equal(none.logo, false);
        assert.equal(none.sigStart, none.start, 'with no logo the signature is at the start, as today');
        assert.equal(model(r, 'reel', { logo: logoOf() }, 'ar').sigStart, null);
    });

    it('follows the switch: off, the Studio\'s ink and first accent; on, the brand\'s', async () => {
        const off = await opened();
        let ctx = off.P.previewContext();
        assert.deepEqual([ctx.ink, ctx.carouselAccent, ctx.reelAccent, ctx.explainerTitle], ['#08080A', '#FFD60A', '#FFD60A', '#FFD43B']);
        const on = await opened({ profile: profileOf({ use_brand_colours: true }) });
        ctx = on.P.previewContext();
        assert.deepEqual([ctx.ink, ctx.carouselAccent, ctx.reelAccent, ctx.explainerTitle], ['#030B11', '#F2A33A', '#F2A33A', '#F2A33A']);
        assert.equal(ctx.infographicBg, '#030B11', 'the infographic page is the primary mixed 82% into black');
        const light = await opened({ profile: profileOf({ theme: 'light' }) });
        assert.equal(light.P.previewContext().infographicBg, '#F7F6F2');
    });

    it('switches the whole preview between Arabic and English, and the buttons say which is on', async () => {
        const r = await opened({ lang: 'ar' });
        const preview = (): string => String(r.cards.preview.innerHTML);
        r.P.repaint('preview');
        assert.equal((preview().match(/dir="rtl"/g) ?? []).length, 5);
        assert.match(preview(), /data-lang="ar" aria-pressed="true"/);
        r.P.setPreviewLang('en');
        assert.equal((preview().match(/dir="ltr"/g) ?? []).length, 5);
        assert.match(preview(), /data-lang="en" aria-pressed="true"/);
        assert.match(preview(), /data-lang="ar" aria-pressed="false"/);
        assert.match(preview(), /role="group" aria-label="[^"]+"/);
    });

    it('draws the logo as it is: the picture of the logo is a plain <img> with its own size, in the page\'s direction, never mirrored by markup', async () => {
        const r = await opened({ profile: profileOf({ logos: { main: LOGO } }) });
        const markup = String(r.container.innerHTML);
        assert.equal(/scaleX|rotate|transform|-1\)/.test(markup), false, 'no flip in the markup');
        assert.ok((markup.match(new RegExp(`<img src="${LOGO.url.replace(/[./]/g, '\\$&')}"`, 'g')) ?? []).length >= 7, 'two swatches and five tiles');
    });
});

describe('Brand page: custom properties are only validated values', () => {
    it('writes a finite number or a #RRGGBB, and nothing else', () => {
        const r = rig();
        const good = r.P.tileModel(r.P.TILES[0], { logo: null, ink: '#030B11', carouselAccent: '#F2A33A', reelAccent: '#F2A33A', explainerTitle: '#F2A33A', infographicBg: '#030B11', infographicAccent: '#F2A33A' }, 'ar');
        const names = (vars: string[][]): string[] => vars.map(([n]) => n!);
        assert.ok(names(r.P.cssVars(good, 0.2)).includes('--bp-bg'));
        const hostile = json(good);
        hostile.bg = 'red; background: url(//evil.example/x)';
        hostile.accent = 'rgb(0,0,0)';
        hostile.bar = '#12345';
        hostile.plate = '#FFFFFF}';
        hostile.top = Number.NaN;
        hostile.outerW = Infinity;
        const vars = r.P.cssVars(hostile, 0.2);
        const written = names(vars);
        for (const bad of ['--bp-bg', '--bp-accent', '--bp-bar', '--bp-plate', '--bp-lt', '--bp-lw']) assert.equal(written.includes(bad), false, `${bad} is dropped`);
        for (const [, value] of vars) assert.match(value!, /^(#[0-9A-F]{6}|-?\d+(\.\d+)?)$/);
    });

    it('sets them from script on each tile and swatch by element, and on nothing else', async () => {
        const r = await opened({ profile: profileOf({ logos: { main: LOGO } }) });
        const els = ['carousel', 'reel'].map((key) => ({ key, set: [] as string[][], getAttribute: () => key, style: { setProperty: (n: string, v: string) => { els.find((e) => e.key === key)!.set.push([n, v]); } } }));
        const swatch = { set: [] as string[][], getAttribute: () => 'dark', style: { setProperty: (n: string, v: string) => { swatch.set.push([n, v]); } } };
        r.P.applyVars({ querySelectorAll: (selector: string) => (selector === '[data-bp-tile]' ? els : selector === '[data-bp-swatch]' ? [swatch] : []) });
        for (const el of els) {
            const names = el.set.map(([n]) => n);
            assert.ok(names.includes('--bp-k') && names.includes('--bp-bg') && names.includes('--bp-lw'), el.key);
        }
        assert.equal(els[0]!.set.find(([n]) => n === '--bp-k')![1], String(Math.round((200 / 1080) * 100000) / 100000));
        assert.equal(swatch.set.find(([n]) => n === '--bp-bg')![1], '#08080A');
        assert.equal(swatch.set.find(([n]) => n === '--bp-plate')![1], '#FFFFFF', 'a dark mark on the dark swatch gets its plate');
    });
});

describe('Brand page: hostile values are text, never markup', () => {
    const attack = '"><img src=x onerror=alert(1)><script>alert(2)</script>';

    it('draws nothing from a stored logo whose url, size or colour is not what the server writes', async () => {
        for (const main of [
            { ...LOGO, url: 'javascript:alert(1)' },
            { ...LOGO, url: `https://x.example/${attack}` },
            { ...LOGO, url: 'data:text/html;base64,PHNjcmlwdD4=' },
            { ...LOGO, colour: `red;background:url(//evil.example/x)${attack}` },
            { ...LOGO, tone: attack },
            { ...LOGO, width: attack },
            { ...LOGO, height: -5 },
            { ...LOGO, alpha: 'yes' },
        ]) {
            const r = await opened({ profile: profileOf({ logos: { main } }) });
            const markup = String(r.container.innerHTML);
            assert.equal(/onerror|<script/i.test(bare(markup)), false, JSON.stringify(main));
            assert.equal(markup.includes('<script'), false, JSON.stringify(main));
            assert.equal(/src="javascript:/i.test(markup), false);
            assert.equal(/src="data:text/i.test(markup), false);
            assert.equal(markup.includes('evil.example'), false, 'a colour is a hex or the fallback');
            assert.equal((markup.match(/data-bp-tile="/g) ?? []).length, 5, 'the page still draws');
            const kept = r.P.savedLogo(r.P.profile);
            if (kept) assert.match(kept.colour, /^#[0-9A-F]{6}$/, 'whatever is kept has a colour that is a hex, or the fallback');
        }
    });

    it('escapes an address that is a valid-looking https URL with markup in it, as an attribute value', async () => {
        const r = await opened({ profile: profileOf({ logos: { main: { ...LOGO, url: `https://x.example/a"onerror="alert(1)` } } }) });
        const markup = String(r.container.innerHTML);
        assert.equal(/onerror/i.test(bare(markup)), false, 'no attribute of that name exists outside a quoted value');
        assert.ok(markup.includes('&quot;onerror=&quot;alert(1)'), 'the quote is entity-escaped inside the attribute');
    });

    it('a hostile primary or accent colour falls back to the defaults and reaches no property', async () => {
        const r = await opened({ profile: profileOf({ primary: `red;${attack}`, accent: 'url(evil)', use_brand_colours: true }) });
        const ctx = r.P.previewContext();
        assert.equal(ctx.ink, '#030B11');
        assert.equal(ctx.carouselAccent, '#F2A33A');
        assert.equal(String(r.container.innerHTML).includes('evil'), false);
    });

    it('a hostile Studio settings value falls back too', async () => {
        const r = await opened({ settings: { settings: { brand: { colors: { ink: attack }, palette: [attack] }, explainer: { title_color: 'expression(1)' } } } });
        const ctx = r.P.previewContext();
        assert.deepEqual([ctx.ink, ctx.carouselAccent, ctx.explainerTitle], ['#08080A', '#FFD60A', '#FFD43B']);
    });
});

// ─── The shell ───────────────────────────────────────────────────────────────────────────────

describe('Brand: the route, the menu and the words', () => {
    const INDEX = readFileSync('dashboard/index.html', 'utf8');
    const APP = readFileSync('dashboard/js/app.js', 'utf8');

    it('is a route of its own with its stylesheet, and the image module is not a route', () => {
        const h = loadDashboard({ app: true });
        const brand = h.App.pages.brand;
        assert.equal(brand.src, 'brand');
        assert.equal(brand.css, true);
        assert.equal(brand.navAs, undefined, 'it has its own menu item');
        assert.equal(h.App.pages.brand_image.src, 'brand_image');
        assert.equal(h.App.pages.brand_image.routable, false);
        assert.match(APP, /^ {8}brand: \{ src: 'brand', page: \(\) => BrandPage, css: true \},$/m);
        assert.match(APP, /^ {8}brand_image: \{ src: 'brand_image', page: \(\) => BrandImage, routable: false \},$/m);
        assert.match(INDEX, /var PAGES = \[[^\]]*'brand'/, 'the head script preloads it');
    });

    it('is in the Content group after Studio, hidden until applyChrome shows it, with the icon already in the subset', () => {
        const item = /<li class="hidden"><a href="#\/brand" class="nav-item" data-page="brand">\s*<i data-lucide="award" aria-hidden="true"><\/i>\s*<span data-i18n="nav.brand">هويتك<\/span>\s*<\/a><\/li>/;
        assert.match(INDEX, item);
        assert.ok(INDEX.indexOf('data-page="studio"') < INDEX.indexOf('data-page="brand"') && INDEX.indexOf('data-page="brand"') < INDEX.indexOf('data-page="posts"'));
        assert.match(readFileSync('dashboard/js/icons.js', 'utf8'), /award/);
    });

    it('applyChrome hides the item from a viewer and shows it to an operator and an owner (through the shell registry, Shell.PAGES)', () => {
        for (const [role, hidden] of [['viewer', true], ['operator', false], ['owner', false]] as const) {
            const h = loadDashboard({ app: true });
            const operatorOnly = h.el('brand-nav');
            operatorOnly.classes.add('hidden');
            const owner = h.el('ads-nav');
            // The registry reads `.nav-item[data-page]` and toggles `hidden` on each item's <li>.
            const link = (page: string, li: FakeEl): Json => ({ getAttribute: (n: string) => (n === 'data-page' ? page : null), parentElement: Object.assign(li, { tagName: 'LI' }) });
            const items = [link('brand', operatorOnly), link('ads', owner)];
            h.document.querySelectorAll = (selector: string): Json[] => (selector === '.nav-item[data-page]' ? items : []);
            h.App.session = { available: true, role: 'member', userId: 'u1', email: 'a@b.test', tenantId: 't1', tenantRole: role, tenants: [{ id: 't1' }], onboarding: null };
            h.App.applyChrome();
            assert.equal(operatorOnly.classes.has('hidden'), hidden, role);
            assert.equal(owner.classes.has('hidden'), role !== 'owner', `${role}: Ads stays the owner's`);
        }
    });

    it('names itself in both languages (the page-title guard reads these two keys)', () => {
        const en = loadDashboard({ lang: 'en', app: true });
        const ar = loadDashboard({ lang: 'ar', app: true });
        assert.equal(en.App.title('brand'), 'Brand');
        assert.equal(ar.App.title('brand'), 'هويتك');
        assert.equal(en.App.subtitle('brand'), 'Your logo and colours on what the Studio makes.');
        assert.equal(ar.App.subtitle('brand'), 'شعارك وألوانك على ما يصنعه الاستوديو.');
    });

    it('has every key the page can ask for, in both languages: none reaches the screen as its raw id', () => {
        const code = (file: string): string => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const source = `${code(PAGE)}\n${code(IMAGE)}`;
        const keys = new Set<string>();
        for (const m of source.matchAll(/['"`](brand\.[A-Za-z]+(?:\.[A-Za-z]+)*)['"`]/g)) keys.add(m[1]!);
        for (const code of ['not_found', 'not_yours', 'private', 'not_png', 'too_big', 'too_small', 'too_large', 'aspect', 'unreadable']) keys.add(`brand.logoError.${code}`);
        // The codes brand_image.js throws and `checkSize` answers become `brand.logo.<code>`.
        for (const code of ['tooSmall', 'badShape', 'tooBig', 'unreadable', 'fileTooBig', 'bgGone']) keys.add(`brand.logo.${code}`);
        keys.add('help.link.brand');
        keys.add('audit.action.brand.logo_upload');
        for (const lang of ['en', 'ar'] as const) {
            const h = loadDashboard({ lang });
            for (const key of keys) {
                if (key.endsWith('.')) continue;
                assert.notEqual(h.t(key), key, `${lang}: ${key}`);
                assert.ok(h.t(key).trim(), `${lang}: ${key} is not empty`);
            }
        }
    });

    it('says in Arabic what the contract says, and keeps the dev words in English', () => {
        const ar = loadDashboard({ lang: 'ar' });
        assert.equal(ar.t('brand.logo.choose'), 'اختر شعارًا');
        assert.equal(ar.t('brand.logo.removeBg'), 'أزل الخلفية');
        assert.equal(ar.t('brand.logo.makeWhite'), 'اجعله أبيض');
        assert.equal(ar.t('brand.logo.save'), 'احفظ الشعار');
        assert.equal(ar.t('brand.logo.remove'), 'أزل الشعار');
        assert.equal(ar.t('brand.logo.facts', { width: 1200, height: 400, background: 'x' }), 'PNG · 1200×400 · x');
        assert.equal(ar.t('audit.action.brand.logo_upload'), 'تغيّر شعار الهوية');
        assert.match(ar.t('brand.logo.formats'), /SVG.*PNG.*JPEG.*WebP/);
    });

    it('has a Help article whose bold labels are the interface\'s own words, in both languages', () => {
        const h = loadDashboard({ lang: 'en' });
        h.evalFile('dashboard/js/help-content.js');
        const article = h.run<Json>('HelpContent').articles.find((a: Json) => a.slug === 'brand');
        assert.ok(article, 'the article exists');
        assert.equal(article.group, 'studio');
        assert.equal(article.icon, 'award');
        assert.deepEqual(json(article.related), ['studio-settings', 'infographics', 'explainers', 'monteur', 'worker']);
        assert.deepEqual(json(article.sections.map((s: Json) => s.id)), ['what', 'logo', 'where', 'plate', 'colours', 'who', 'troubleshooting']);
        const bold = (lang: 'ar' | 'en'): string[] => {
            const text = JSON.stringify(article.sections.map((s: Json) => s.body[lang]));
            return [...text.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]!);
        };
        const labels = (lang: 'ar' | 'en'): string[] => ['brand.logo.choose', 'brand.logo.removeBg', 'brand.logo.makeWhite', 'brand.logo.save', 'brand.logo.remove', 'brand.colours.switch'].map((k) => loadDashboard({ lang }).t(k));
        for (const lang of ['en', 'ar'] as const) {
            const found = bold(lang);
            for (const label of labels(lang)) assert.ok(found.includes(label), `${lang}: **${label}** is in the article`);
        }
    });
});

describe('Brand: the stylesheet', () => {
    const CSS = readFileSync('dashboard/css/pages/brand.css', 'utf8');
    const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

    it('closes every block it opens', () => {
        let depth = 0;
        for (const ch of stripped) {
            if (ch === '{') depth++;
            if (ch === '}') { depth--; assert.ok(depth >= 0, 'a } with nothing open'); }
        }
        assert.equal(depth, 0);
    });

    it('uses logical properties only: nothing is left or right', () => {
        for (const bad of [/\bmargin-(left|right)\b/, /\bpadding-(left|right)\b/, /\b(left|right)\s*:/, /text-align\s*:\s*(left|right)/, /\bborder-(left|right)\b/, /\bfloat\s*:\s*(left|right)/]) {
            assert.equal(bad.test(stripped), false, String(bad));
        }
    });

    it('has no colour of its own: tokens and the --bp-* properties script sets', () => {
        assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(stripped), false, 'no hex colour');
        assert.equal(/\brgba?\(|\bhsla?\(/.test(stripped), false, 'no functional colour');
        const colours = [...stripped.matchAll(/(?:background|color|border(?:-[a-z]+)*|box-shadow|accent-color)\s*:\s*([^;}]+)/g)].map((m) => m[1]!);
        for (const value of colours) {
            assert.ok(/var\(--/.test(value) || /^(none|transparent|0|inherit|currentColor|1px solid var\(--border-subtle\))/.test(value.trim()) || /^\d/.test(value.trim()), `a colour value: ${value}`);
        }
    });

    it('keeps the language toggle and the strip scrollable on a phone', () => {
        assert.match(CSS, /\.brand-lang \{[^}]*overflow-x: auto/);
        assert.match(CSS, /\.bp-strip \{[^}]*overflow-x: auto/);
        assert.match(CSS, /@media \(min-width: 861px\)/);
    });

    it('is loaded by the route\'s `css: true` and not linked by the shell', () => {
        assert.equal(readFileSync('dashboard/index.html', 'utf8').includes('css/pages/brand.css'), false);
    });
});

// The real browser pieces (a canvas, a file input, the SVG parser) are verified live: the harness has no canvas.
