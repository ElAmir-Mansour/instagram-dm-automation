/**
 * The brand display face (L3): Alexandria 600, one subset woff2 under public/brand/, and the seven files that name it.
 *
 * `npm run check:font` is the guard CI runs; this file tests the guard. The first block asserts the committed font is what the
 * spec says (at most 48 KB, named for its own hash, Arabic and Latin in it, nothing outside the subset). The second asserts the
 * check catches what it exists to catch, by mutating one file at a time IN MEMORY (makeIo lays overrides over the repo) and
 * requiring a problem that names the mutation. A guard that was never shown to fail has not been shown to work, and a mutation
 * that matched nothing would pass silently, so every mutation below first asserts that its anchor exists.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
    BRAND_DIR,
    FALLBACK,
    FONT_FILE,
    FONT_DISPLAY,
    LICENCE_FILE,
    MANIFEST,
    MAX_BYTES,
    METRICS,
    PAGES,
    SPEC,
    STYLESHEET,
    TOKENS,
    cmapOf,
    collectProblems,
    dashboardDisplayText,
    faceCss,
    formatRanges,
    htmlText,
    parseRanges,
    preloadTag,
    publicDisplayText,
    readWoff2,
    uncovered,
} from './build-font.mjs';

const read = (rel) => readFileSync(rel, 'utf8');
const manifest = JSON.parse(read(MANIFEST));
const FILE = manifest.output.file;
const fontBytes = readFileSync(`${BRAND_DIR}/${FILE}`);
const cps = cmapOf(readWoff2(fontBytes).get('cmap').bytes);
const cmap = new Set(cps);

/** The problems the check finds with `overrides` laid over the repo. */
const problemsWith = (overrides) => collectProblems(process.cwd(), overrides);

describe('the committed display font', () => {
    it('passes the whole check on a clean tree (a check that fails on a clean tree would make every mutation below meaningless)', () => {
        assert.deepEqual(collectProblems(), []);
    });

    it('is a subset of the budget: at most 48 KB, a woff2, named for the SHA-256 of its own bytes', () => {
        assert.ok(fontBytes.length <= 48 * 1024, `${fontBytes.length} bytes`);
        assert.equal(MAX_BYTES, 48 * 1024);
        assert.equal(fontBytes.toString('latin1', 0, 4), 'wOF2');
        const hash = createHash('sha256').update(fontBytes).digest('hex');
        assert.match(FILE, FONT_FILE);
        assert.equal(FONT_FILE.exec(FILE)[1], hash.slice(0, 8));
        assert.equal(manifest.output.sha256, hash);
        assert.equal(manifest.output.bytes, fontBytes.length);
    });

    it('is the weight-600 instance, not the variable font, and keeps what Arabic shaping and mark placement need', () => {
        const tables = readWoff2(fontBytes);
        for (const t of ['cmap', 'glyf', 'hmtx', 'GSUB', 'GPOS', 'GDEF']) assert.ok(tables.has(t), `has ${t}`);
        for (const t of ['fvar', 'gvar', 'avar', 'HVAR', 'STAT']) assert.equal(tables.has(t), false, `no ${t}`);
        assert.equal(manifest.output.builtWith.fontTools.length > 0, true);
        // 568 glyphs, not the 1,935 of the source: the subset really happened.
        assert.ok(manifest.output.glyphs < 700, `${manifest.output.glyphs} glyphs`);
    });

    it('draws Arabic: the letters, the harakat, both digit sets and the Arabic punctuation', () => {
        const need = [
            ...parseRanges('U+0621-063A,U+0641-064A'), // the alphabet
            ...parseRanges('U+064B-0652'), // fathatan .. sukun
            ...parseRanges('U+0660-0669,U+06F0-06F9'), // Arabic-Indic and Persian digits
            0x060c, 0x061b, 0x061f, 0x0640, // ، ؛ ؟ tatweel
        ];
        const missing = need.filter((c) => !cmap.has(c));
        assert.deepEqual(missing, [], `missing: ${formatRanges(missing)}`);
    });

    it('draws Latin, the digits the pages use, and the punctuation: ASCII, NBSP, guillemets, the middle dot, dashes and curly quotes', () => {
        const need = [...parseRanges('U+0020-007E'), ...[0x00a0, 0x00ab, 0x00bb, 0x00b7, 0x00d7, 0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026]];
        const missing = need.filter((c) => !cmap.has(c));
        assert.deepEqual(missing, [], `missing: ${formatRanges(missing)}`);
    });

    it('carries nothing outside the spec subset (no Latin Extended, no Vietnamese, no maths)', () => {
        const allowed = new Set(parseRanges(SPEC.unicodes));
        assert.deepEqual(cps.filter((c) => !allowed.has(c)), []);
        assert.equal(cmap.has(0x0100), false);
        assert.equal(cmap.has(0x1ea0), false);
        assert.equal(manifest.output.coverage, formatRanges(cps), 'the manifest records the coverage the file really has');
    });

    it('covers every code point of the display text of the six public pages and the dashboard headings', () => {
        const entries = [];
        for (const p of PAGES) for (const text of publicDisplayText(read(p.file))) entries.push({ text, where: p.file });
        const dict = ['ar', 'en'].map((l) => read(`dashboard/js/i18n.${l}.js`));
        for (const text of dashboardDisplayText(read('dashboard/index.html'), dict)) entries.push({ text, where: 'dashboard' });
        // A scan that found nothing would pass: it finds the wordmark, an h1 per page, dozens of h2s and the dashboard's titles.
        assert.ok(entries.length > 150, `${entries.length} display strings`);
        assert.ok(entries.some((e) => e.text.includes('أوتوريبلاي برو')), 'the wordmark');
        assert.ok(entries.some((e) => e.where === 'dashboard' && e.text === 'نظرة عامة'), 'a dashboard page title');
        assert.ok(entries.some((e) => e.where === 'public/landing.html' && /^\d+$/.test(e.text.trim())), 'a figure');
        assert.deepEqual(uncovered(entries, cmap), []);
    });

    it('ships the OFL, unchanged, beside the font, and the name table keeps the copyright and licence notice', () => {
        const ofl = read(`${BRAND_DIR}/${LICENCE_FILE}`);
        assert.match(ofl, /Copyright 2022 The Alexandria Project Authors/);
        assert.match(ofl, /SIL OPEN FONT LICENSE Version 1\.1/);
        assert.equal(createHash('sha256').update(ofl).digest('hex'), SPEC.source.licenceSha256);
        // Name ids 0 (copyright), 13 (licence description) and 14 (licence URL) are in the name table: look for their strings in the file.
        const name = readWoff2(fontBytes).get('name').bytes;
        const utf16 = (s) => Buffer.from(s, 'utf16le').swap16();
        for (const s of ['Copyright 2022 The Alexandria Project Authors', 'SIL Open Font License, Version 1.1', 'http://scripts.sil.org/OFL']) {
            assert.ok(name.includes(utf16(s)) || name.includes(Buffer.from(s, 'latin1')), `name table holds "${s}"`);
        }
    });

    it('is pinned: one google/fonts commit, one SHA-256, and the OFL names no Reserved Font Name', () => {
        assert.match(SPEC.source.commit, /^[0-9a-f]{40}$/);
        assert.match(SPEC.source.sha256, /^[0-9a-f]{64}$/);
        assert.equal(manifest.spec.source.commit, SPEC.source.commit);
        assert.equal(SPEC.weight, 600);
        assert.equal(/with Reserved Font Name/i.test(read(`${BRAND_DIR}/${LICENCE_FILE}`).split('\n')[0] ?? ''), false);
    });

    it('lives in /brand with the licence and nothing of this script\'s but this release and the one before', () => {
        const mine = readdirSync(BRAND_DIR).filter((f) => FONT_FILE.test(f) || f === LICENCE_FILE);
        assert.ok(mine.includes(FILE) && mine.includes(LICENCE_FILE));
        assert.ok(mine.length <= 3, mine.join(', '));
    });
});

describe('the @font-face block this script writes', () => {
    const css = faceCss(FILE);

    it('is Alexandria 600 with `swap`, from this origin, and is the same text everywhere it is pasted', () => {
        assert.match(css, /font-family: 'Alexandria';\s+font-style: normal;\s+font-weight: 600;\s+font-display: swap;\s+src: url\('\/brand\/alexandria-600\.[0-9a-f]{8}\.woff2'\) format\('woff2'\);/);
        assert.equal(/fonts\.(googleapis|gstatic)\.com|https?:\/\//.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), false);
        const flat = (s) => s.replace(/^[ \t]+/gm, '');
        for (const rel of [...PAGES.map((p) => p.file), STYLESHEET.file]) assert.ok(flat(read(rel)).includes(flat(css)), `${rel} carries the block`);
    });

    it('declares a size-adjusted local fallback per script, with Alexandria\'s own vertical metrics', () => {
        for (const [script, f] of Object.entries(FALLBACK)) {
            assert.ok(f.sizeAdjust > 0.9 && f.sizeAdjust < 1.4, `${script} size-adjust ${f.sizeAdjust}`);
            assert.ok(f.local.length >= 2 && f.local.every((n) => /Bold/.test(n)), `${script} falls back to bold local faces (the display weight is 600)`);
            const sa = `${Math.round(f.sizeAdjust * 10000) / 100}%`;
            assert.ok(css.includes(`size-adjust: ${sa};`), `${script}: ${sa}`);
        }
        // ascent/descent are Alexandria's divided by size-adjust (size-adjust scales them again), and line-gap is 0.
        for (const f of Object.values(FALLBACK)) {
            const pct = (n) => `${Math.round((n / METRICS.unitsPerEm / f.sizeAdjust) * 10000) / 100}%`;
            assert.ok(css.includes(`ascent-override: ${pct(METRICS.ascent)};`));
            assert.ok(css.includes(`descent-override: ${pct(METRICS.descent)};`));
        }
        assert.match(css, /line-gap-override: 0%;/);
        assert.equal(manifest.output.metrics.ascent, METRICS.ascent, 'METRICS are the font\'s hhea metrics');
        assert.equal(manifest.output.metrics.descent, -METRICS.descent);
        // The two scripts split by unicode-range, so each gets its own scale.
        assert.match(css, /unicode-range: U\+0000-05FF, U\+2000-206F;/);
        assert.match(css, /unicode-range: U\+0600-06FF, U\+0750-077F, U\+FB50-FDFF, U\+FE70-FEFF;/);
    });

    it('is the stack tokens.css names', () => {
        assert.equal(FONT_DISPLAY, "--font-display: 'Alexandria', 'Alexandria Fallback', var(--font-ui);");
        assert.ok(read(TOKENS).includes(FONT_DISPLAY));
    });

    it('preloads with crossorigin as a font, and the tag is exactly the one the landing carries', () => {
        assert.equal(preloadTag(FILE), `<link rel="preload" href="/brand/${FILE}" as="font" type="font/woff2" crossorigin>`);
        assert.ok(read('public/landing.html').includes(preloadTag(FILE)));
    });
});

describe('the check fails on what it exists to catch (each mutation applied in memory, anchor asserted first)', () => {
    /** Replace `from` with `to` in a repo file; the anchor must exist exactly once. */
    const mutate = (rel, from, to) => {
        const text = read(rel);
        assert.equal(text.split(from).length - 1, 1, `${rel}: the mutation anchor "${from.slice(0, 50)}" matches exactly once`);
        return { [rel]: text.replace(from, () => to) };
    };
    const has = (problems, re) => assert.ok(problems.some((p) => re.test(p)), `no problem matched ${re}; got:\n${problems.join('\n')}`);

    it('a page naming a stale font file', () => {
        has(problemsWith(mutate('public/terms.html', FILE, 'alexandria-600.deadbeef.woff2')), /terms\.html.*differs from what scripts\/build-font\.mjs generates/);
    });

    it('the landing losing its preload', () => {
        const landing = read('public/landing.html');
        const tag = preloadTag(FILE);
        assert.equal(landing.split(tag).length - 1, 1);
        has(problemsWith({ 'public/landing.html': landing.replace(tag, '') }), /landing\.html: expected exactly .*found no preload/);
    });

    it('a second page preloading the font', () => {
        const privacy = read('public/privacy.html');
        const at = privacy.indexOf('<link rel="stylesheet" href="/dashboard/css/tokens.css');
        assert.ok(at > 0);
        has(problemsWith({ 'public/privacy.html': `${privacy.slice(0, at)}${preloadTag(FILE)}\n    ${privacy.slice(at)}` }), /privacy\.html preloads the font, and only the landing may/);
    });

    it('a preload without crossorigin (the browser would fetch the font twice)', () => {
        const tag = preloadTag(FILE);
        has(problemsWith(mutate('public/landing.html', tag, tag.replace(' crossorigin', ''))), /landing\.html: expected exactly/);
    });

    it('one of the seven copies of the block drifting (a different size-adjust in pricing.html)', () => {
        has(problemsWith(mutate('public/pricing.html', 'size-adjust: 115%;', 'size-adjust: 120%;')), /pricing\.html: the display-face block differs/);
    });

    it('the stylesheet losing its block', () => {
        const css = read(STYLESHEET.file);
        const from = css.indexOf('/* ─── Display face: Alexandria 600 (generated)');
        const to = css.indexOf('/* ─── end of display face ─── */');
        assert.ok(from >= 0 && to > from);
        has(problemsWith({ [STYLESHEET.file]: css.slice(0, from) + css.slice(to + '/* ─── end of display face ─── */'.length) }), /styles\.css carries 0 display-face blocks/);
    });

    it('--font-display drifting from the stack the fallback belongs to', () => {
        has(problemsWith(mutate(TOKENS, FONT_DISPLAY, "--font-display: 'Alexandria', var(--font-ui);")), /tokens\.css: expected exactly/);
    });

    it('the font file changing without a rebuild (one byte flipped)', () => {
        const flipped = Buffer.from(fontBytes);
        flipped[flipped.length - 5] ^= 0xff;
        has(problemsWith({ [`${BRAND_DIR}/${FILE}`]: flipped }), /holds bytes that hash to|SHA-256 differs/);
    });

    it('the font going missing, or the licence', () => {
        has(problemsWith({ [`${BRAND_DIR}/${FILE}`]: null }), /does not exist: the manifest names it/);
        has(problemsWith({ [`${BRAND_DIR}/${LICENCE_FILE}`]: null }), /OFL\.txt is missing/);
        has(problemsWith({ [`${BRAND_DIR}/${LICENCE_FILE}`]: 'Not the licence' }), /not the upstream OFL\.txt/);
    });

    it('a third font in /brand (this release and the one before are the most)', () => {
        const extra = { [`${BRAND_DIR}/alexandria-600.aaaaaaaa.woff2`]: Buffer.from('x'), [`${BRAND_DIR}/alexandria-600.bbbbbbbb.woff2`]: Buffer.from('y') };
        has(problemsWith(extra), /at most 2: this release and the one before/);
    });

    it('a font over the 48 KB budget', () => {
        const big = Buffer.concat([fontBytes, Buffer.alloc(MAX_BYTES)]);
        has(problemsWith({ [`${BRAND_DIR}/${FILE}`]: big }), /over the 48\.0 KB budget/);
    });

    it('a heading that asks for a glyph the font does not have (a Greek capital in the 404 heading)', () => {
        const text = read('public/404.html');
        const m = /<h1\b[^>]*>/.exec(text);
        assert.ok(m, 'the 404 has an h1');
        has(problemsWith({ 'public/404.html': text.replace(m[0], `${m[0]}Ω `) }), /display text in public\/404\.html uses U\+03A9/);
    });

    it('the manifest recording a different subset or source from the script\'s', () => {
        const changed = structuredClone(manifest);
        changed.spec.unicodes = 'U+0020-007E';
        has(problemsWith({ [MANIFEST]: JSON.stringify(changed) }), /records a different spec/);
        const moved = structuredClone(manifest);
        moved.fallback.arabic.sizeAdjust = 1.3;
        has(problemsWith({ [MANIFEST]: JSON.stringify(moved) }), /records a different FALLBACK/);
    });

    it('a manifest that is not there', () => {
        has(problemsWith({ [MANIFEST]: null }), /manifest\.json is missing/);
    });
});

describe('the helpers the check stands on', () => {
    it('parses and writes code point ranges in the notation DESIGN.md uses', () => {
        assert.deepEqual(parseRanges('U+0020-0022,U+0041'), [0x20, 0x21, 0x22, 0x41]);
        assert.equal(formatRanges([0x20, 0x21, 0x22, 0x41, 0x600]), 'U+0020-0022,U+0041,U+0600');
        assert.equal(formatRanges(parseRanges(SPEC.unicodes)), formatRanges(parseRanges(formatRanges(parseRanges(SPEC.unicodes)))));
    });

    it('refuses what is not a woff2', () => {
        assert.throws(() => readWoff2(Buffer.from('not a font at all, nowhere near 48 bytes of woff2 header....')), /not a woff2/);
    });

    it('reads display text out of markup, entities and tags included, and keeps an unknown entity visible', () => {
        assert.equal(htmlText('a<bdi lang="ar">ب</bdi>&nbsp;&mdash;&#x41;').replace(/ +/g, ' '), 'a ب  —A');
        assert.ok(htmlText('x&bogus;').includes('�'));
        const html = '<h1 class="a">One</h1><h2>Two <bdi>2</bdi></h2><a class="wordmark" href="/"><bdi>اسم</bdi><bdi class="latin">Name</bdi></a><dl class="figures"><div><dt>14</dt><dd>x</dd></div></dl><dl class="tally"><dt>3</dt></dl><h3>Not display</h3>';
        assert.deepEqual(publicDisplayText(html).map((s) => s.replace(/\s+/g, ' ').trim()), ['One', 'Two 2', 'اسم Name', '14', '3']);
    });

    it('does not count whitespace or invisible bidi controls, and does count a missing glyph', () => {
        assert.deepEqual(uncovered([{ text: 'a ‏⁧b⁩', where: 'x' }], new Set([0x61, 0x62])), []);
        assert.deepEqual(uncovered([{ text: 'aΩ', where: 'x' }], new Set([0x61])).map((u) => u.cp), [0x03a9]);
    });
});
