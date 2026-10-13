/** Colours and logo (docs/onboarding/03 §3.4): found by code, deterministic, and never from the model or from a photograph. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { brandColours, inkAndPaper, logoCandidates, MIN_CONTRAST, parseManifest } from './brand.js';
import { colourDistance, contrastRatio, hexToRgb, hslToRgb, hueDistance, isBrandable, parseColour, rgbToHsl, toHex } from './colour.js';
import { fixture } from './fixtures/load.js';
import { extractSite } from './siteExtract.js';

describe('parseColour', () => {
    const cases: Array<[string, string | null]> = [
        ['#7b3f61', '#7B3F61'], ['#7B3F61', '#7B3F61'], ['#fff', '#FFFFFF'], ['#0af', '#00AAFF'], ['#7b3f61ff', '#7B3F61'], ['#7b3f61cc', '#7B3F61'], ['#7b3f6100', null], ['#f0f0', null], ['#f0f8', '#FF00FF'],
        ['#12345', null], ['#1234567', null], ['#ggg', null], ['#', null], ['7b3f61', null],
        ['rgb(123, 63, 97)', '#7B3F61'], ['rgb(123 63 97)', '#7B3F61'], ['rgba(123,63,97,0.5)', '#7B3F61'], ['rgba(123,63,97,0)', null], ['rgb(100%, 0%, 0%)', '#FF0000'], ['rgb(300, 0, 0)', '#FF0000'],
        ['rgb(123 63 97 / 80%)', '#7B3F61'], ['rgb(12, 34)', null], ['rgb(a, b, c)', null],
        ['hsl(330, 32%, 38%)', '#80425F'], ['hsl(330 32% 38%)', '#80425F'], ['hsla(0, 100%, 50%, 1)', '#FF0000'], ['hsla(0, 100%, 50%, 0)', null], ['hsl(120deg 100% 25%)', '#008000'],
        ['red', null], ['transparent', null], ['currentColor', null], ['inherit', null], ['var(--x)', null], ['', null],
        ['#7B3F61 !important', '#7B3F61'],
    ];
    for (const [input, expected] of cases) {
        it(`${JSON.stringify(input)} is ${expected}`, () => {
            const got = parseColour(input);
            if (expected === '#80425F') assert.ok(got !== null && colourDistance(got, expected) < 6, `${input} gave ${got}`);
            else assert.equal(got, expected);
        });
    }
});

describe('colour arithmetic', () => {
    it('round-trips hex, RGB and HSL', () => {
        for (const hex of ['#7B3F61', '#FF0000', '#00FF00', '#0000FF', '#2E7D6B', '#F2A541', '#808080', '#000000', '#FFFFFF']) {
            const rgb = hexToRgb(hex)!;
            assert.equal(toHex(rgb), hex);
            assert.ok(colourDistance(toHex(hslToRgb(rgbToHsl(rgb))), hex) < 2, hex);
        }
        assert.equal(hexToRgb('nope'), null);
    });

    it('measures hue distance round the wheel', () => {
        assert.equal(hueDistance(10, 350), 20);
        assert.equal(hueDistance(0, 180), 180);
        assert.equal(hueDistance(90, 90), 0);
        assert.equal(hueDistance(-10, 10), 20);
        assert.equal(hueDistance(720, 0), 0);
    });

    it('measures WCAG contrast', () => {
        assert.equal(Math.round(contrastRatio('#000000', '#FFFFFF')), 21);
        assert.equal(contrastRatio('#7B3F61', '#7B3F61'), 1);
        assert.ok(Math.abs(contrastRatio('#767676', '#FFFFFF') - 4.54) < 0.05, 'the lightest grey that passes AA on white');
        assert.equal(contrastRatio('nope', '#FFFFFF'), 1);
    });

    it('drops greys and the near-white and near-black, at the edges the spec gives', () => {
        assert.equal(isBrandable('#808080'), false, 'a grey');
        assert.equal(isBrandable('#FFFFFF'), false);
        assert.equal(isBrandable('#000000'), false);
        assert.equal(isBrandable('#7B3F61'), true);
        assert.equal(isBrandable('#F2F2F7'), false, 'saturated but near white');
        assert.equal(isBrandable('#0A0A14'), false, 'saturated but near black');
        // Saturation 15%: hsl(200, 15%, 50%) is the lowest that counts, and a hair under does not.
        assert.equal(isBrandable(toHex(hslToRgb({ h: 200, s: 0.16, l: 0.5 }))), true);
        assert.equal(isBrandable(toHex(hslToRgb({ h: 200, s: 0.1, l: 0.5 }))), false);
        // Lightness 8% to 92%.
        assert.equal(isBrandable(toHex(hslToRgb({ h: 200, s: 0.8, l: 0.09 }))), true);
        assert.equal(isBrandable(toHex(hslToRgb({ h: 200, s: 0.8, l: 0.06 }))), false);
        assert.equal(isBrandable(toHex(hslToRgb({ h: 200, s: 0.8, l: 0.91 }))), true);
        assert.equal(isBrandable(toHex(hslToRgb({ h: 200, s: 0.8, l: 0.95 }))), false);
    });
});

describe('brandColours: the order of trust', () => {
    const css = fixture('theme.css');

    it('takes theme-color first, then the manifest, then CSS custom properties, then CSS frequency, then SVG', () => {
        const all = { themeColor: '#2255CC', manifestThemeColor: '#CC5522', css: [css], svg: [fixture('logo.svg')] };
        assert.deepEqual([brandColours(all).primary, brandColours(all).primarySource], ['#2255CC', 'theme-color']);
        assert.deepEqual([brandColours({ ...all, themeColor: null }).primary, brandColours({ ...all, themeColor: null }).primarySource], ['#CC5522', 'manifest']);
        assert.deepEqual([brandColours({ ...all, themeColor: null, manifestThemeColor: null }).primary, brandColours({ ...all, themeColor: null, manifestThemeColor: null }).primarySource], ['#7B3F61', 'css-var']);
        const frequency = brandColours({ css: ['a { color: #118833; } a:hover { color: #118833 } p { color: #CC2299 }'], svg: [fixture('logo.svg')] });
        assert.deepEqual([frequency.primary, frequency.primarySource], ['#118833', 'css-frequency']);
        const svg = brandColours({ svg: [fixture('logo.svg')] });
        assert.deepEqual([svg.primary, svg.primarySource], ['#2E7D6B', 'svg']);
    });

    it('falls through a theme-color that is white, grey or black, as it does for any source', () => {
        for (const bad of ['#FFFFFF', '#000000', '#CCCCCC', '#0b0b0b', 'not a colour', '', 'transparent']) {
            const out = brandColours({ themeColor: bad, manifestThemeColor: '#6B2D5C' });
            assert.equal(out.primary, '#6B2D5C', bad);
            assert.equal(out.primarySource, 'manifest');
        }
    });

    it('finds nothing when there is nothing: no primary, no accent', () => {
        assert.deepEqual(brandColours({}), { primary: null, accent: null, primarySource: null, palette: [] });
        const greys = brandColours({ themeColor: '#ffffff', css: ['body { color: #333; background: #fafafa } a { color: #666 }'] });
        assert.equal(greys.primary, null);
    });

    it('reads CSS custom properties by name, in the order primary, brand, accent, bs-primary, and follows var()', () => {
        const out = brandColours({ css: [':root { --bs-primary: #0d6efd; --accent: #E4572E; --brand: #2E7D6B; --primary: var(--indigo); --indigo: #4B3F9E; --unrelated: #ff00aa }'] });
        assert.equal(out.primary, '#4B3F9E');
        assert.deepEqual(out.palette.slice(0, 4), ['#4B3F9E', '#2E7D6B', '#E4572E', '#0D6EFD']);
        assert.ok(!out.palette.includes('#FF00AA'), '--unrelated is not a brand colour');
        assert.equal(brandColours({ css: [':root { --color-primary: #118833 }'] }).primary, '#118833');
        assert.equal(brandColours({ css: [':root { --my-favourite: #118833; --primary-light: #118833; --secondary: #118833 }'] }).primary, null, 'only the names the spec lists, with their usual affixes');
        assert.equal(brandColours({ css: [':root { --primary: var(--missing) }'] }).primary, null);
        assert.equal(brandColours({ css: [':root { --a: var(--b); --b: var(--a); --primary: var(--a) }'] }).primary, null, 'a loop is not a colour');
    });

    it('takes the :root definition and not a dark-mode override that comes later', () => {
        assert.equal(brandColours({ css: [css] }).palette[0], '#7B3F61');
    });

    it('counts CSS frequency three times inside button, a and header', () => {
        // Four plain uses of red against one use of blue in a link (3): red wins. Two links (6): blue wins.
        const plain = '.a { color: #C0392B } .b { color: #C0392B } .c { color: #C0392B } .d { color: #C0392B } a { color: #2980B9 }';
        assert.equal(brandColours({ css: [plain] }).primary, '#C0392B');
        const links = `${plain} a:hover { color: #2980B9 }`;
        assert.equal(brandColours({ css: [links] }).primary, '#2980B9');
        assert.equal(brandColours({ css: [`${plain} header { background: #2980B9 }`] }).primary, '#2980B9');
        assert.equal(brandColours({ css: [`${plain} button { background: #2980B9 } .btn-x { border-color: #2980B9 }`] }).primary, '#2980B9');
        assert.equal(brandColours({ css: [`${plain} .abutton-like { background: #2980B9 }`] }).primary, '#C0392B', 'only whole selectors count: "a", "header", "button"');
        assert.equal(brandColours({ css: [`${plain} .nav a { color: #2980B9 } .x a:hover { color: #2980B9 }`] }).primary, '#2980B9', 'descendant selectors count');
    });

    it('reads colours only where colours are painted, and ignores font-face, comments and data URIs', () => {
        const out = brandColours({
            css: [fixture('theme.css'), '/* a { color: #00FF00 } */ @font-face { src: url(data:font/woff2;base64,AA;AA); color: #FF00FF } .x { background: url("data:image/svg+xml;utf8,<svg fill=\'%23ff0000\'/>") } .y { width: 100px; z-index: 5; margin: 0 }'],
        });
        assert.ok(!out.palette.includes('#00FF00'));
        assert.ok(!out.palette.includes('#FF00FF'));
        assert.ok(!out.palette.includes('#FF0000'));
    });

    it('merges colours that are the same colour, and never offers one twice', () => {
        const out = brandColours({ css: ['a { color: #7B3F61 } a:hover { color: #7C4062 } p { color: #7A3E60 }'] });
        assert.deepEqual(out.palette, ['#7B3F61']);
        assert.equal(out.accent, null, 'nothing else to be an accent');
    });

    it('chooses an accent at least 30 degrees of hue from the primary, skipping closer ones', () => {
        // Primary hue ~330. A near-hue darker variant (hue ~330) is skipped; the gold (~39) is the accent.
        const out = brandColours({ css: [':root { --primary: #7B3F61; --brand: #A8527F; --accent: #D9A441 }'] });
        assert.equal(out.primary, '#7B3F61');
        assert.equal(out.accent, '#D9A441');
        const hue = (hex: string) => rgbToHsl(hexToRgb(hex)!).h;
        assert.ok(hueDistance(hue(out.primary!), hue(out.accent!)) >= 30);
        // Only same-hue colours: no accent at all, rather than a bad one.
        assert.equal(brandColours({ css: [':root { --primary: #7B3F61; --brand: #A8527F }'] }).accent, null);
        // 25 degrees is not enough; 36 is. (A third colour of the same lightness a few degrees on would be merged as a near-duplicate.)
        const at = (h: number, l: number) => toHex(hslToRgb({ h, s: 0.7, l }));
        const under = brandColours({ css: [`:root { --primary: ${at(200, 0.4)}; --brand: ${at(225, 0.4)} }`] });
        assert.equal(under.primary, at(200, 0.4));
        assert.equal(under.accent, null);
        const over = brandColours({ css: [`:root { --primary: ${at(200, 0.4)}; --brand: ${at(225, 0.4)}; --accent: ${at(236, 0.65)} }`] });
        assert.equal(over.accent, at(236, 0.65));
    });

    it('reads SVG fills, colours the SVG says in a style and in an attribute alike, and drops the white and the grey', () => {
        const out = brandColours({ svg: [fixture('logo.svg')] });
        assert.deepEqual(out.palette, ['#2E7D6B', '#F2A541']);
    });

    it('never throws on hostile CSS', () => {
        const hostile = ['{{{{', '}}}}', 'a{', 'a{color:', `a{color:${'('.repeat(10000)}`, `a{${'x:y;'.repeat(100000)}}`, '"', "'", '/*', ':root{--a:var(--a)}', 'a{color:#12'.repeat(5000), `${'a{b:c}'.repeat(50000)}`];
        for (const css of hostile) assert.doesNotThrow(() => brandColours({ css: [css] }), css.slice(0, 20));
    });

    it('is deterministic: the same inputs give the same answer', () => {
        const input = { themeColor: null, css: [fixture('theme.css')], svg: [fixture('logo.svg')] };
        assert.deepEqual(brandColours(input), brandColours(input));
    });

    it('reads the fixtures the way the extractor hands them over', () => {
        const site = extractSite(fixture('salla-store.html'), 'https://noor-perfumes.example/');
        const out = brandColours({ themeColor: site.themeColor, css: site.inlineStyles });
        assert.equal(out.primary, '#7B3F61');
        assert.equal(out.primarySource, 'theme-color');
    });
});

describe('inkAndPaper', () => {
    const PRIMARIES = ['#7B3F61', '#2E7D6B', '#F2A541', '#FFD60A', '#0D6EFD', '#E4572E', '#4B3F9E', '#118833', '#C0392B', '#2980B9', '#8E44AD', '#16A085', '#F39C12', '#D35400', '#27AE60', '#1ABC9C', '#E91E63', '#795548', '#607D8B', '#FF5722'];

    for (const theme of ['light', 'dark'] as const) {
        it(`gives a ${theme} pair that contrasts at 4.5 or better for every one of ${PRIMARIES.length} primaries`, () => {
            for (const primary of [...PRIMARIES, null]) {
                const { ink, paper } = inkAndPaper(primary, theme);
                assert.match(ink, /^#[0-9A-F]{6}$/);
                assert.match(paper, /^#[0-9A-F]{6}$/);
                assert.ok(contrastRatio(ink, paper) >= MIN_CONTRAST, `${primary} ${theme}: ${ink} on ${paper} is ${contrastRatio(ink, paper).toFixed(2)}`);
            }
        });
    }

    it('puts the light paper above the ink and the dark paper below it', () => {
        const light = inkAndPaper('#7B3F61', 'light');
        const dark = inkAndPaper('#7B3F61', 'dark');
        assert.ok(rgbToHsl(hexToRgb(light.paper)!).l > rgbToHsl(hexToRgb(light.ink)!).l);
        assert.ok(rgbToHsl(hexToRgb(dark.paper)!).l < rgbToHsl(hexToRgb(dark.ink)!).l);
    });

    it('tints toward the brand hue, and is plain grey for no brand', () => {
        const tinted = rgbToHsl(hexToRgb(inkAndPaper('#2E7D6B', 'light').paper)!);
        assert.ok(hueDistance(tinted.h, rgbToHsl(hexToRgb('#2E7D6B')!).h) < 10);
        const plain = hexToRgb(inkAndPaper(null, 'light').paper)!;
        assert.equal(plain.r, plain.g);
        assert.equal(plain.g, plain.b);
    });
});

describe('the logo', () => {
    const site = extractSite(fixture('salla-store.html'), 'https://noor-perfumes.example/');
    const manifest = parseManifest(fixture('manifest.json'), 'https://noor-perfumes.example/manifest.json');

    it('goes JSON-LD logo, apple-touch-icon, then the largest PNG icons, most trusted first', () => {
        const { candidates } = logoCandidates(site, manifest);
        assert.deepEqual(candidates.map((c) => [c.source, c.url.replace('https://noor-perfumes.example', ''), c.size]), [
            ['jsonld', '/assets/logo-512.png', 0],
            ['apple-touch-icon', '/apple-touch-icon.png', 180],
            ['manifest', '/icons/icon-512.png', 512],
            ['icon', '/icon-192.png', 192],
            ['manifest', '/icons/icon-192.png', 192],
        ]);
    });

    it('NEVER offers og:image or a profile picture, however the page names them', () => {
        const { candidates, svg } = logoCandidates(site, manifest);
        const og = site.og['og:image']!;
        assert.ok(og.includes('founder-photo'));
        for (const c of [...candidates, ...svg]) {
            assert.notEqual(c.url, og);
            assert.doesNotMatch(c.url, /photo|portrait|avatar|profile/i);
        }
        // Even a page whose ONLY image is its og:image has no logo.
        const only = extractSite('<head><meta property="og:image" content="https://x.example/me.jpg"><meta property="og:image:secure_url" content="https://x.example/me2.jpg"><meta name="twitter:image" content="https://x.example/me3.jpg"></head>', 'https://x.example/');
        assert.deepEqual(logoCandidates(only), { candidates: [], svg: [] });
    });

    it('leaves out .ico and GIF, and keeps SVG apart: colours only', () => {
        const page = extractSite(
            `<head><link rel="icon" href="/f.ico"><link rel="icon" type="image/gif" href="/a.gif"><link rel="icon" type="image/svg+xml" href="/i.svg"><link rel="icon" sizes="64x64" href="/i.png">
            <script type="application/ld+json">{"@type":"Organization","name":"X","logo":"https://x.example/logo.svg"}</script></head>`,
            'https://x.example/',
        );
        const { candidates, svg } = logoCandidates(page);
        assert.deepEqual(candidates.map((c) => c.url), ['https://x.example/i.png']);
        assert.deepEqual(svg.map((c) => c.url).sort(), ['https://x.example/i.svg', 'https://x.example/logo.svg']);
        assert.ok(svg.every((c) => c.format === 'svg'));
    });

    it('lists a manifest SVG as an SVG, and an address with no extension as unknown until its bytes are seen', () => {
        const { svg } = logoCandidates(site, manifest);
        assert.deepEqual(svg.map((c) => c.url), ['https://noor-perfumes.example/icons/icon.svg']);
        const page = extractSite('<head><script type="application/ld+json">{"@type":"Organization","name":"X","logo":"https://x.example/brand/logo"}</script></head>', 'https://x.example/');
        assert.deepEqual(logoCandidates(page).candidates.map((c) => [c.url, c.format]), [['https://x.example/brand/logo', 'unknown']]);
    });

    it('returns at most five, without repeats, and nothing for a page with no icons', () => {
        const icons = Array.from({ length: 12 }, (_, i) => `<link rel="apple-touch-icon" sizes="${100 + i}x${100 + i}" href="/t${i}.png">`).join('');
        const page = extractSite(`<head>${icons}<link rel="apple-touch-icon" sizes="100x100" href="/t0.png"></head>`, 'https://x.example/');
        const { candidates } = logoCandidates(page);
        assert.equal(candidates.length, 5);
        assert.equal(new Set(candidates.map((c) => c.url)).size, 5);
        assert.deepEqual(candidates.map((c) => c.size), [111, 110, 109, 108, 107], 'largest first');
        assert.deepEqual(logoCandidates(extractSite('<p>x</p>', 'https://x.example/')), { candidates: [], svg: [] });
    });
});

describe('parseManifest', () => {
    it('reads the fixture: colours, names and icons as absolute addresses, a javascript: icon dropped', () => {
        const m = parseManifest(fixture('manifest.json'), 'https://noor-perfumes.example/manifest.json')!;
        assert.equal(m.name, 'متجر نور للعطور');
        assert.equal(m.themeColor, '#6B2D5C');
        assert.equal(m.backgroundColor, '#FFFFFF');
        assert.deepEqual(m.icons.map((i) => [i.size, i.src]), [
            [48, 'https://noor-perfumes.example/icons/icon-48.png'],
            [512, 'https://noor-perfumes.example/icons/icon-512.png'],
            [192, 'https://noor-perfumes.example/icons/icon-192.png'],
            [0, 'https://noor-perfumes.example/icons/icon.svg'],
        ]);
    });

    it('answers null for what is not a manifest and survives every wrong shape', () => {
        for (const text of ['', 'not json', '[]', 'null', '1', '"s"']) assert.equal(parseManifest(text, 'https://x.example/m.json'), null, text);
        assert.equal(parseManifest('{}', 'not a url'), null);
        const odd = parseManifest('{"icons": "nope", "theme_color": 5, "name": {"a":1}}', 'https://x.example/m.json')!;
        assert.deepEqual(odd, { name: '', shortName: '', themeColor: null, backgroundColor: null, icons: [] });
        const many = parseManifest(JSON.stringify({ icons: Array.from({ length: 100 }, (_, i) => ({ src: `/i${i}.png`, sizes: '48x48' })) }), 'https://x.example/m.json')!;
        assert.equal(many.icons.length, 20);
    });
});
