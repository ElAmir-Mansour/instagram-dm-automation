#!/usr/bin/env node
/**
 * Builds and checks the share cards: one 1200x630 PNG per language, named for the hash of its own bytes (L5).
 *
 *   public/brand/og-ar.<sha8>.png   what a link to any of the five indexed pages shows in Arabic (WhatsApp, Telegram, X, LinkedIn,
 *   public/brand/og-en.<sha8>.png   Facebook, iMessage); /brand/* is served `immutable` for a year, so a changed card is a new URL
 *   scripts/og/manifest.json        what the build recorded: the hash of the composition, the renderer, each PNG's hash and size
 *
 * What is on the card. Text only, which is IDENTITY.md section 8's OG v1: the page ground, the "Rows" pattern in the reading-end strip
 * (one lit bar, the only cardamom besides the headline's one lit word), the wordmark, the headline from the landing's H1 with its last
 * word lit like the `.kw` highlighter, and the descriptor from the footer. No mark: the new Kufi mark waits for TikTok's acceptance
 * (DESIGN.md section 4), and the frozen zap is not the brand any more. Every colour is a token value from dashboard/css/tokens.css
 * (dark), and `--check` reads tokens.css to prove they still are. The face is the committed Alexandria 600 subset (L3), embedded in
 * the page as a data URI, so no system font is ever used and the card is the landing's own typography.
 *
 * The one step that needs a tool outside node is the rasteriser: headless Chrome, which shapes the Arabic with HarfBuzz exactly as a
 * visitor's browser does (the font's own GSUB and GPOS, harakat included), where a hand-rolled shaper would have to be proved. It
 * renders at device scale factor 1 with a forced sRGB profile and no GPU, and the same Chrome gives the same bytes; the manifest
 * records which Chrome. `--check` does not need it.
 *
 *   node scripts/build-og.mjs [--chrome <path>] [--workdir <dir>]
 *                                         render both cards, write them and the manifest, and point the five pages at them
 *   node scripts/build-og.mjs --check     change nothing, needs only node. Exit 1 unless
 *                                           - the manifest's composition hash is the composition this file builds now,
 *                                           - each PNG is named for its own hash, is 1200x630 and at most 300 KB,
 *                                           - /brand holds this release's card per language and at most one before it,
 *                                           - the five pages name this release in og:image AND twitter:image, both languages,
 *                                           - every colour on the card is the token it claims to be,
 *                                           - the committed font covers every character on the cards.
 *   node scripts/build-og.mjs --reproduce --check, then render again and compare the bytes with the committed cards (needs Chrome).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmapOf, makeIo, readWoff2 } from './build-font.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BRAND_DIR = 'public/brand';
export const MANIFEST = 'scripts/og/manifest.json';
export const TOKENS_CSS = 'dashboard/css/tokens.css';
export const LANGS = ['ar', 'en'];
/** The pages a crawler or a link preview is meant to reach. The 404 is noindex, and the Eid page is another campaign's. */
export const PAGES = ['landing', 'pricing', 'privacy', 'terms', 'data-deletion'].map((p) => `public/${p}.html`);
export const WIDTH = 1200;
export const HEIGHT = 630;
/** IDENTITY.md section 8: 1200x630 PNG, at most 300 KB. */
export const MAX_BYTES = 300 * 1000;
export const IMAGE_FILE = /^og-(ar|en)\.([0-9a-f]{8})\.png$/;
/** This release's card and the one before it: a link preview fetched from a page the CDN still serves finds its own. */
export const MAX_RELEASES = 2;

/** Dark values of dashboard/css/tokens.css. `--pattern-ink` does not exist there yet (the motif PR adds it): the value is IDENTITY.md section 3. */
export const TOKENS = {
    '--surface-page': '#111210',
    '--text-strong': '#f2f3ec',
    '--text-default': '#d2d4ca',
    '--accent-soft': 'rgba(188,222,112,0.16)',
    '--accent-ring': 'rgba(188,222,112,0.4)',
    '--accent-text': '#c9e683',
};
export const PATTERN_INK = 'rgba(255,255,255,0.06)';

/**
 * The words are the page's own: the headline is the landing's H1 and the descriptor is the footer's one-liner
 * (`landingTruth.test.ts` pins both). `before` + `lit` + `after` is the headline, the lit word being the one the `.kw`
 * highlighter marks on the landing.
 */
export const CARDS = {
    ar: {
        dir: 'rtl',
        wordmark: 'أوتوريبلاي برو',
        before: 'فيديوهاتك تصير منشورات، وتعليقاتهم تصير ',
        lit: 'محادثات',
        after: '',
        descriptor: 'استوديو نموّ مُدار لصنّاع المحتوى العرب',
        // Arabic runs narrower than Latin at the same size, so it takes IDENTITY's 72px; the English headline is longer and wider.
        headlineSize: 72,
    },
    en: {
        dir: 'ltr',
        wordmark: 'AutoReply Pro',
        before: 'Your videos become posts. Their comments become ',
        lit: 'conversations',
        after: '.',
        descriptor: 'A managed growth studio for Arabic creators',
        headlineSize: 60,
    },
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A seeded generator: the Rows are the same on every machine. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * The Rows pattern (IDENTITY.md section 3): 8px pills with 8px gaps, lengths from {16,24,32,48,64}, a row every 24px, every third row a
 * short reply indented 32px, aligned to the inline-start and ragged at the end. In the strip at the reading end (the left in Arabic, the
 * right in English), so the headline, which starts at the other side, never sits on it. One bar is lit.
 */
export function rowsSvg(dir) {
    const W = 300;
    const rnd = mulberry32(0x5e7a11);
    const lens = [16, 24, 32, 48, 64];
    const rect = (x, y, w, fill, ring) =>
        `<rect x="${x}" y="${y}" width="${w}" height="8" rx="4" fill="${fill}"${ring ? ` stroke="${ring}" stroke-width="1"` : ''}/>`;
    const parts = [];
    for (let k = 0; k * 24 < HEIGHT; k++) {
        const reply = k % 3 === 2;
        const indent = reply ? 32 : 0;
        // Row 13 is the lit one, and must be long enough to hold its lit third bar.
        const budget = k === 13 ? W : reply ? 80 + Math.floor(rnd() * 5) * 16 : 128 + Math.floor(rnd() * 9) * 16;
        let used = 0;
        let n = 0;
        for (;;) {
            // The lit bar is the third bar of one row, in the reading-end third of the card, and the longest length (so it reads at thumbnail size).
            const lit = k === 13 && n === 2;
            const drawn = lens[Math.floor(rnd() * lens.length)];
            const len = lit ? 64 : drawn;
            if (used + len > Math.min(budget, W - indent)) break;
            const near = indent + used;
            const x = dir === 'rtl' ? W - near - len : near;
            parts.push(lit ? rect(x + 0.5, 24 * k + 8.5, len - 1, TOKENS['--accent-soft'], TOKENS['--accent-ring']) : rect(x, 24 * k + 8, len, PATTERN_INK));
            used += len + 8;
            n++;
        }
    }
    return `<svg class="rows" width="${W}" height="${HEIGHT}" viewBox="0 0 ${W} ${HEIGHT}" aria-hidden="true">${parts.join('')}</svg>`;
}

/** The card as one HTML page. `fontBase64` is the woff2, or any placeholder when only the composition is being hashed. */
export function composeHtml(lang, fontBase64) {
    const c = CARDS[lang];
    const ar = lang === 'ar';
    const css = [
        `@font-face{font-family:"Alexandria OG";font-weight:600;font-style:normal;src:url(data:font/woff2;base64,${fontBase64}) format("woff2")}`,
        '*{box-sizing:border-box}',
        `html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}`,
        `body{position:relative;background:${TOKENS['--surface-page']};color:${TOKENS['--text-strong']};font-family:"Alexandria OG";font-weight:600;font-synthesis:none;text-rendering:geometricPrecision}`,
        `.rows{position:absolute;top:0;${ar ? 'left' : 'right'}:0}`,
        `.col{position:absolute;top:0;bottom:0;${ar ? 'right' : 'left'}:285px;width:600px;display:flex;flex-direction:column;justify-content:center}`,
        `.wordmark{margin:0 0 ${ar ? 40 : 36}px;font-size:34px;line-height:1.3;color:${TOKENS['--text-default']};${ar ? 'word-spacing:-.04em' : 'letter-spacing:-.01em'}}`,
        `h1{margin:0 0 ${ar ? 36 : 32}px;font-size:${c.headlineSize}px;line-height:${ar ? 1.3 : 1.08};font-weight:600;color:${TOKENS['--text-strong']};text-wrap:balance;${ar ? '' : 'letter-spacing:-.01em'}}`,
        `.kw{display:inline-block;padding:.02em .16em;margin-inline:-.1em;border-radius:.18em;background:${TOKENS['--accent-soft']};box-shadow:inset 0 0 0 1px ${TOKENS['--accent-ring']};color:${TOKENS['--accent-text']}}`,
        `.descriptor{margin:0;font-size:30px;line-height:${ar ? 1.6 : 1.4};color:${TOKENS['--text-default']};text-wrap:balance}`,
    ].join('\n');
    return [
        '<!doctype html>',
        `<html lang="${lang}" dir="${c.dir}">`,
        `<head><meta charset="utf-8"><title>og-${lang}</title><style>`,
        css,
        '</style></head>',
        '<body>',
        rowsSvg(c.dir),
        '<main class="col">',
        `<p class="wordmark">${esc(c.wordmark)}</p>`,
        `<h1>${esc(c.before)}<span class="kw">${esc(c.lit)}</span>${esc(c.after)}</h1>`,
        `<p class="descriptor">${esc(c.descriptor)}</p>`,
        '</main>',
        '</body></html>',
        '',
    ].join('\n');
}

/** What the manifest records as the composition: both pages with the font taken out, so a rebuilt font does not move it. */
export function specHash() {
    return sha256(JSON.stringify({ width: WIDTH, height: HEIGHT, html: Object.fromEntries(LANGS.map((l) => [l, composeHtml(l, 'FONT')])) }));
}

/** Width and height from a PNG's IHDR, or null when it is not a PNG. */
export function pngSize(buf) {
    if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG' || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const kb = (n) => (n / 1000).toFixed(1);
const fileFor = (lang, bytes) => `og-${lang}.${sha256(bytes).slice(0, 8)}.png`;
/** The font file the landing preloads: the committed one this release is typeset in. */
const fontNameIn = (landing) => /\/brand\/(alexandria-600\.[0-9a-f]{8}\.woff2)/.exec(landing)?.[1] ?? null;

// ─── --check ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every character the cards print that is not a space, as the code points a font must have. */
export function cardCodePoints() {
    const out = new Set();
    for (const c of Object.values(CARDS)) for (const ch of [c.wordmark, c.before, c.lit, c.after, c.descriptor].join('')) if (!/\s/.test(ch)) out.add(ch.codePointAt(0));
    return [...out].sort((a, b) => a - b);
}

/** The first definition of `--name` in tokens.css is the dark theme's, which is the default. */
function tokenValue(css, name) {
    const m = new RegExp(`${name.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+);`).exec(css);
    return m ? m[1].replace(/\s+/g, '').toLowerCase() : null;
}

/** Everything wrong with the committed cards and the pages that name them, as readable lines. `overrides` as in build-font's makeIo. */
export function collectProblems(root = ROOT, overrides = {}) {
    const io = makeIo(root, overrides);
    const problems = [];
    let manifest;
    try {
        manifest = JSON.parse(io.text(MANIFEST));
    } catch (e) {
        return [`${MANIFEST} is missing or not JSON (${e.message}): run node scripts/build-og.mjs`];
    }
    if (manifest.spec !== specHash()) problems.push(`${MANIFEST} records a different composition than scripts/build-og.mjs builds now: re-render (node scripts/build-og.mjs) so the cards show what the script says`);

    const brand = io.names(BRAND_DIR);
    for (const lang of LANGS) {
        const rec = manifest.images?.[lang];
        if (!rec) {
            problems.push(`${MANIFEST} has no card for ${lang}`);
            continue;
        }
        const m = IMAGE_FILE.exec(rec.file);
        if (!m || m[1] !== lang) problems.push(`${MANIFEST}: ${lang} card is named ${rec.file}, expected og-${lang}.<sha8>.png`);
        let bytes = null;
        try {
            bytes = io.bytes(`${BRAND_DIR}/${rec.file}`);
        } catch {
            problems.push(`${BRAND_DIR}/${rec.file} is missing`);
        }
        if (bytes) {
            if (m && m[2] !== sha256(bytes).slice(0, 8)) problems.push(`${rec.file} is not named for the SHA-256 of its own bytes (${sha256(bytes).slice(0, 8)})`);
            if (sha256(bytes) !== rec.sha256) problems.push(`${rec.file}: ${MANIFEST} records a different hash than the file has`);
            if (bytes.length > MAX_BYTES) problems.push(`${rec.file} is ${bytes.length} bytes, over the ${MAX_BYTES} limit`);
            const size = pngSize(bytes);
            if (!size) problems.push(`${rec.file} is not a PNG`);
            else if (size.width !== WIDTH || size.height !== HEIGHT) problems.push(`${rec.file} is ${size.width}x${size.height}, not ${WIDTH}x${HEIGHT}`);
        }
        const releases = brand.filter((n) => IMAGE_FILE.exec(n)?.[1] === lang);
        if (!releases.includes(rec.file)) problems.push(`${BRAND_DIR} does not hold ${rec.file}`);
        if (releases.length > MAX_RELEASES) problems.push(`${BRAND_DIR} holds ${releases.length} ${lang} cards (${releases.join(', ')}); keep this release and one before it`);

        for (const page of PAGES) {
            let html;
            try {
                html = io.text(page);
            } catch {
                problems.push(`${page} is missing`);
                continue;
            }
            for (const prop of ['property="og:image"', 'name="twitter:image"']) {
                const tag = new RegExp(`<meta ${prop} data-lang-only="${lang}" content="\\{\\{SITE_ORIGIN\\}\\}/brand/([^"]+)">`, 'g');
                const found = [...html.matchAll(tag)].map((x) => x[1]);
                if (found.length !== 1 || found[0] !== rec.file) problems.push(`${page}: ${prop} for ${lang} is ${found.length ? found.join(', ') : 'absent'}, expected exactly ${rec.file}`);
            }
        }
    }

    try {
        const tokens = io.text(TOKENS_CSS);
        for (const [name, value] of Object.entries(TOKENS)) {
            const actual = tokenValue(tokens, name);
            if (actual !== value.replace(/\s+/g, '').toLowerCase()) problems.push(`the card's ${name} is ${value}, tokens.css has ${actual}: the card must use the brand's own value`);
        }
    } catch {
        problems.push(`${TOKENS_CSS} is missing`);
    }

    try {
        const font = fontNameIn(io.text('public/landing.html'));
        if (!font) problems.push('public/landing.html does not preload the display font, so the cards have no face to be checked against');
        else {
            const have = new Set(cmapOf(readWoff2(io.bytes(`${BRAND_DIR}/${font}`)).get('cmap').bytes));
            const missing = cardCodePoints().filter((cp) => !have.has(cp));
            if (missing.length) problems.push(`${font} has no glyph for ${missing.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`).join(' ')}, which the cards print`);
        }
    } catch (e) {
        problems.push(`could not read the display font (${e.message})`);
    }
    return problems;
}

// ─── build ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function findChrome(explicit) {
    const candidates = [explicit, process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'google-chrome', 'chromium'].filter(Boolean);
    for (const bin of candidates) {
        try {
            const version = execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            return { bin, version };
        } catch {
            /* try the next */
        }
    }
    throw new Error('no Chrome found: pass --chrome <path> or set CHROME_BIN');
}

/** Render one composition to PNG bytes with headless Chrome, using `workdir` for the page and the throwaway profile. */
function render(chrome, html, name, workdir) {
    const page = join(workdir, `${name}.html`);
    const png = join(workdir, `${name}.png`);
    writeFileSync(page, html);
    execFileSync(
        chrome.bin,
        [
            '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--force-color-profile=srgb',
            '--font-render-hinting=none', '--disable-lcd-text', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
            '--run-all-compositor-stages-before-draw', '--virtual-time-budget=4000',
            `--window-size=${WIDTH},${HEIGHT}`, `--user-data-dir=${join(workdir, 'profile')}`, `--screenshot=${png}`, `file://${page}`,
        ],
        { stdio: ['ignore', 'ignore', 'ignore'], timeout: 90_000 }
    );
    const bytes = readFileSync(png);
    unlinkSync(png);
    unlinkSync(page);
    return bytes;
}

function renderAll(chrome, workdir) {
    const font = readFileSync(join(ROOT, BRAND_DIR, fontNameIn(readFileSync(join(ROOT, 'public/landing.html'), 'utf8')) ?? ''));
    const out = {};
    for (const lang of LANGS) out[lang] = render(chrome, composeHtml(lang, font.toString('base64')), `og-${lang}`, workdir);
    return out;
}

function withWorkdir(arg, fn) {
    const own = !arg;
    const workdir = arg ? resolve(arg) : mkdtempSync(join(tmpdir(), 'build-og-'));
    mkdirSync(workdir, { recursive: true });
    try {
        return fn(workdir);
    } finally {
        // Only a directory this run created in the OS temp dir, which holds Chrome's throwaway profile. A --workdir the caller named is theirs.
        if (own && workdir.startsWith(tmpdir()) && basename(workdir).startsWith('build-og-')) rmSync(workdir, { recursive: true, force: true });
    }
}

function build(args) {
    const at = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    const chrome = findChrome(at('--chrome'));
    const images = withWorkdir(at('--workdir'), (workdir) => renderAll(chrome, workdir));
    const previous = existsSync(join(ROOT, MANIFEST)) ? JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf8')) : { images: {} };
    const recorded = {};
    for (const lang of LANGS) {
        const bytes = images[lang];
        const size = pngSize(bytes);
        if (!size || size.width !== WIDTH || size.height !== HEIGHT) throw new Error(`Chrome produced ${size ? `${size.width}x${size.height}` : 'no PNG'} for ${lang}, expected ${WIDTH}x${HEIGHT}`);
        if (bytes.length > MAX_BYTES) throw new Error(`the ${lang} card is ${bytes.length} bytes, over the ${MAX_BYTES} limit`);
        const file = fileFor(lang, bytes);
        writeFileSync(join(ROOT, BRAND_DIR, file), bytes);
        recorded[lang] = { file, sha256: sha256(bytes), bytes: bytes.length };
        // Keep this release and the one before it; anything older goes.
        const keep = new Set([file, previous.images?.[lang]?.file]);
        for (const n of readdirSync(join(ROOT, BRAND_DIR))) if (IMAGE_FILE.exec(n)?.[1] === lang && !keep.has(n)) unlinkSync(join(ROOT, BRAND_DIR, n));
    }
    mkdirSync(join(ROOT, dirname(MANIFEST)), { recursive: true });
    writeFileSync(join(ROOT, MANIFEST), `${JSON.stringify({ spec: specHash(), renderer: chrome.version, font: fontNameIn(readFileSync(join(ROOT, 'public/landing.html'), 'utf8')), images: recorded }, null, 2)}\n`);
    for (const page of PAGES) {
        const path = join(ROOT, page);
        let html = readFileSync(path, 'utf8');
        let n = 0;
        for (const lang of LANGS) {
            html = html.replace(new RegExp(`/brand/og-${lang}\\.[0-9a-f]{8}\\.png`, 'g'), () => (n++, `/brand/${recorded[lang].file}`));
        }
        if (n !== 4) throw new Error(`${page}: expected 4 references to a card (og:image and twitter:image, two languages), rewrote ${n}`);
        writeFileSync(path, html);
    }
    for (const lang of LANGS) console.log(`built ${recorded[lang].file}: ${kb(recorded[lang].bytes)} KB (limit ${kb(MAX_BYTES)}), ${WIDTH}x${HEIGHT}, ${chrome.version}`);
    console.log(`pointed ${PAGES.length} pages at them; run npm run check:og`);
}

function reproduce(args) {
    const at = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    const chrome = findChrome(at('--chrome'));
    const manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf8'));
    const images = withWorkdir(at('--workdir'), (workdir) => renderAll(chrome, workdir));
    let bad = 0;
    for (const lang of LANGS) {
        if (sha256(images[lang]) !== manifest.images[lang].sha256) {
            console.error(`not reproducible: ${lang} renders to ${sha256(images[lang])} with ${chrome.version}, the committed card to ${manifest.images[lang].sha256} (rendered with ${manifest.renderer}; or the font changed since)`);
            bad++;
        }
    }
    if (bad) process.exit(1);
    console.log(`reproduced: both cards are byte-identical to a fresh render with ${chrome.version}`);
}

function main() {
    const args = process.argv.slice(2);
    if (args.includes('--check') || args.includes('--reproduce')) {
        const problems = collectProblems();
        if (problems.length) {
            console.error('\nshare-card check failed:\n');
            for (const p of problems) console.error(`   - ${p}\n`);
            process.exit(1);
        }
        const m = JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf8'));
        console.log(`og ok: ${LANGS.map((l) => `${m.images[l].file} ${kb(m.images[l].bytes)} KB`).join(', ')} (limit ${kb(MAX_BYTES)}), named by ${PAGES.length} pages, rendered by ${m.renderer}`);
        if (args.includes('--reproduce')) reproduce(args);
        return;
    }
    build(args);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
