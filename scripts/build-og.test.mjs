/**
 * The share cards (L5): two 1200x630 PNGs under public/brand/, and the five pages that name them.
 *
 * `npm run check:og` is the guard CI runs; this file tests the guard and the composition. The first block asserts the committed cards are
 * what the script says. The second asserts the check catches what it exists to catch, by mutating one file at a time IN MEMORY
 * (`makeIo` lays overrides over the repo) and requiring a problem that names the mutation. A mutation that matched nothing would pass
 * silently, so each one first asserts that its anchor exists. The third pins what the cards may show: the page's own words, the brand's
 * own colours, no mark, no logo, no picture of anyone.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
    BRAND_DIR,
    CARDS,
    HEIGHT,
    IMAGE_FILE,
    LANGS,
    MANIFEST,
    MAX_BYTES,
    MAX_RELEASES,
    PAGES,
    PATTERN_INK,
    TOKENS,
    TOKENS_CSS,
    WIDTH,
    cardCodePoints,
    collectProblems,
    composeHtml,
    pngSize,
    rowsSvg,
    specHash,
} from './build-og.mjs';

const read = (rel) => readFileSync(rel, 'utf8');
const manifest = JSON.parse(read(MANIFEST));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const problemsWith = (overrides) => collectProblems(process.cwd(), overrides);

/** Replace `from` with `to` in a file's text, failing first if `from` is not there exactly `times` times. */
function mutate(rel, from, to, times = 1) {
    const text = read(rel);
    assert.equal(text.split(from).length - 1, times, `mutation anchor "${from}" in ${rel}`);
    return text.split(from).join(to);
}

describe('the committed share cards', () => {
    it('pass the whole check on a clean tree (a check that fails on a clean tree would make every mutation below meaningless)', () => {
        assert.deepEqual(collectProblems(), []);
    });

    for (const lang of LANGS) {
        it(`${lang}: 1200x630, at most 300 KB, named for the SHA-256 of its own bytes, recorded in the manifest`, () => {
            const rec = manifest.images[lang];
            const bytes = readFileSync(`${BRAND_DIR}/${rec.file}`);
            assert.deepEqual(pngSize(bytes), { width: WIDTH, height: HEIGHT });
            assert.deepEqual([WIDTH, HEIGHT], [1200, 630]);
            assert.ok(bytes.length <= MAX_BYTES && MAX_BYTES === 300 * 1000, `${bytes.length} bytes`);
            assert.match(rec.file, IMAGE_FILE);
            assert.equal(IMAGE_FILE.exec(rec.file)[2], sha(bytes).slice(0, 8));
            assert.equal(rec.sha256, sha(bytes));
            assert.equal(rec.bytes, bytes.length);
        });
    }

    it('are this release and at most one before it in /brand', () => {
        for (const lang of LANGS) {
            const mine = readdirSync(BRAND_DIR).filter((f) => IMAGE_FILE.exec(f)?.[1] === lang);
            assert.ok(mine.includes(manifest.images[lang].file));
            assert.ok(mine.length <= MAX_RELEASES, mine.join(', '));
        }
    });

    it('record the composition they were rendered from, and the renderer', () => {
        assert.equal(manifest.spec, specHash());
        assert.match(manifest.renderer, /Chrome/);
        assert.match(manifest.font, /^alexandria-600\.[0-9a-f]{8}\.woff2$/);
    });

    it('are named by every indexed page, in both languages, for og:image and twitter:image alike, and by nothing else', () => {
        for (const page of PAGES) {
            const html = read(page);
            for (const lang of LANGS) {
                const refs = [...html.matchAll(new RegExp(`/brand/(og-${lang}\\.[0-9a-f]{8}\\.png)`, 'g'))].map((m) => m[1]);
                assert.deepEqual(refs, [manifest.images[lang].file, manifest.images[lang].file], `${page} ${lang}`);
            }
        }
        for (const other of ['public/404.html', 'dashboard/eid.html']) assert.equal(/og-(ar|en)\./.test(read(other)), false, `${other} is not an indexed page`);
    });
});

describe('the guard catches what it exists to catch', () => {
    const AR = manifest.images.ar.file;
    const png = (lang) => readFileSync(`${BRAND_DIR}/${manifest.images[lang].file}`);

    it('a page that names a card which is not the current one', () => {
        const problems = problemsWith({ 'public/pricing.html': mutate('public/pricing.html', `/brand/${AR}`, '/brand/og-ar.deadbeef.png', 2) });
        assert.ok(problems.some((p) => p.includes('public/pricing.html') && p.includes('og:image') && p.includes(AR)), problems.join('\n'));
    });

    it('a page that lost its twitter:image', () => {
        const html = read('public/terms.html');
        const tag = /\s*<meta name="twitter:image" data-lang-only="en" content="[^"]+">/.exec(html);
        assert.ok(tag, 'mutation anchor: the English twitter:image tag');
        const problems = problemsWith({ 'public/terms.html': html.replace(tag[0], '') });
        assert.ok(problems.some((p) => p.includes('public/terms.html') && p.includes('twitter:image') && p.includes('en')), problems.join('\n'));
    });

    it('a composition changed without a re-render', () => {
        const problems = problemsWith({ [MANIFEST]: JSON.stringify({ ...manifest, spec: '0'.repeat(64) }) });
        assert.ok(problems.some((p) => p.includes('different composition')), problems.join('\n'));
    });

    it('a card that is not 1200x630', () => {
        const bytes = Buffer.from(png('ar'));
        assert.equal(bytes.readUInt32BE(16), 1200);
        bytes.writeUInt32BE(1080, 16);
        const problems = problemsWith({ [`${BRAND_DIR}/${AR}`]: bytes });
        assert.ok(problems.some((p) => p.includes('1080x630')), problems.join('\n'));
    });

    it('a card over 300 KB', () => {
        const bytes = Buffer.concat([png('en'), Buffer.alloc(MAX_BYTES)]);
        const problems = problemsWith({ [`${BRAND_DIR}/${manifest.images.en.file}`]: bytes });
        assert.ok(problems.some((p) => p.includes('over the')), problems.join('\n'));
    });

    it('a file that is not named for its own bytes, or is not a PNG', () => {
        const problems = problemsWith({ [`${BRAND_DIR}/${AR}`]: Buffer.from('not a png at all, just text that is long enough to read') });
        assert.ok(problems.some((p) => p.includes('not named for the SHA-256')), problems.join('\n'));
        assert.ok(problems.some((p) => p.includes('is not a PNG')), problems.join('\n'));
    });

    it('a card that is missing', () => {
        const problems = problemsWith({ [`${BRAND_DIR}/${AR}`]: null });
        assert.ok(problems.some((p) => p.includes(`${AR} is missing`)), problems.join('\n'));
    });

    it('a third release left in /brand', () => {
        const problems = problemsWith({ [`${BRAND_DIR}/og-ar.00000001.png`]: 'x', [`${BRAND_DIR}/og-ar.00000002.png`]: 'y' });
        assert.ok(problems.some((p) => p.includes('holds 3 ar cards')), problems.join('\n'));
    });

    it('a colour on the card that is no longer the brand\'s token', () => {
        const css = mutate(TOKENS_CSS, '--accent-text: #c9e683;', '--accent-text: #aaff00;');
        const problems = problemsWith({ [TOKENS_CSS]: css });
        assert.ok(problems.some((p) => p.includes('--accent-text') && p.includes('#aaff00')), problems.join('\n'));
    });

    it('a character on the card that the font does not have', () => {
        // The check reads the font the landing preloads; point it at a woff2 that is not Alexandria's by renaming the preload to a missing file.
        const landing = read('public/landing.html');
        const problems = problemsWith({ 'public/landing.html': landing.replaceAll(/alexandria-600\.[0-9a-f]{8}\.woff2/g, 'alexandria-600.00000000.woff2') });
        assert.ok(problems.some((p) => p.includes('could not read the display font')), problems.join('\n'));
    });

    it('a missing manifest', () => {
        assert.ok(problemsWith({ [MANIFEST]: null }).some((p) => p.includes('missing or not JSON')));
    });
});

describe('what the cards may show', () => {
    it('are the page\'s own words: the landing\'s H1 and its eyebrow, in each language, and the product\'s name', () => {
        const landing = read('public/landing.html');
        // The headline's words, with the lit word's <span> (B2) taken out: the card prints the same sentence.
        const text = (id) => new RegExp(`<h1 id="${id}">(.+?)</h1>`).exec(landing)?.[1]?.replace(/<\/?span[^>]*>/g, '');
        for (const [lang, id] of [['ar', 'hero-ar'], ['en', 'hero-en']]) {
            const c = CARDS[lang];
            assert.equal(`${c.before}${c.lit}${c.after}`, text(id), `${lang} headline`);
            assert.ok(landing.includes(`</span>${c.descriptor}</p>`), `${lang} descriptor is the landing's eyebrow`);
            assert.ok(landing.includes(c.wordmark), `${lang} wordmark appears on the page`);
        }
        assert.equal(CARDS.ar.wordmark, 'أوتوريبلاي برو');
        assert.equal(CARDS.en.wordmark, 'AutoReply Pro');
    });

    it('light one word of the headline, the one the `.kw` highlighter marks on the landing, and nothing else', () => {
        for (const lang of LANGS) {
            const html = composeHtml(lang, 'FONT');
            assert.equal((html.match(/class="kw"/g) ?? []).length, 1, lang);
            assert.ok(html.includes(`<span class="kw">${CARDS[lang].lit}</span>`));
            assert.equal(CARDS[lang].lit.includes(' '), false, 'one word');
        }
        assert.equal(CARDS.ar.lit, 'محادثات');
        assert.equal(CARDS.en.lit, 'conversations');
    });

    it('are text and shapes only: no image, no logo, no mark, no person', () => {
        for (const lang of LANGS) {
            const html = composeHtml(lang, 'FONT');
            assert.equal(/<img|<image|<use|<picture|<video|<canvas|<symbol|plogo|favicon|mark-|<path/i.test(html), false, `${lang}: only <rect>s and text`);
            assert.equal(/url\((?!data:font\/woff2)/.test(html), false, `${lang}: no url() but the embedded font`);
        }
        assert.equal(/<path/.test(rowsSvg('rtl') + rowsSvg('ltr')), false);
    });

    it('use only the brand\'s own colours: the dark tokens, and the pattern ink', () => {
        const allowed = new Set([...Object.values(TOKENS), PATTERN_INK].map((v) => v.replace(/\s+/g, '').toLowerCase()));
        for (const lang of LANGS) {
            const html = composeHtml(lang, 'FONT');
            const colours = [...html.matchAll(/#[0-9a-fA-F]{6}\b|rgba?\([^)]*\)/g)].map((m) => m[0].replace(/\s+/g, '').toLowerCase());
            assert.ok(colours.length > 10, `${lang}: ${colours.length} colours were read`);
            for (const c of colours) assert.ok(allowed.has(c), `${lang}: ${c} is not a brand token`);
        }
    });

    it('keep the words inside the centre 630x630 square, and the Rows in the strip at the reading end', () => {
        // The text column is 600px wide, 285px in from its own side: x 315..915 in Arabic (anchored right), 285..885 in English.
        const ar = composeHtml('ar', 'FONT');
        const en = composeHtml('en', 'FONT');
        assert.match(ar, /\.col\{[^}]*right:285px;width:600px/);
        assert.match(en, /\.col\{[^}]*left:285px;width:600px/);
        const centre = [(WIDTH - 630) / 2, (WIDTH + 630) / 2];
        assert.deepEqual(centre, [285, 915]);
        for (const [from, to] of [[WIDTH - 285 - 600, WIDTH - 285], [285, 285 + 600]]) assert.ok(from >= centre[0] && to <= centre[1], `${from}..${to} is inside ${centre}`);
        // Arabic reads right to left, so the Rows are at the left and the text begins at the right; English is the mirror.
        assert.match(ar, /\.rows\{position:absolute;top:0;left:0\}/);
        assert.match(en, /\.rows\{position:absolute;top:0;right:0\}/);
    });

    it('draw the Rows as IDENTITY.md says: 8px pills on a 24px row, lengths from {16,24,32,48,64}, one lit bar', () => {
        for (const dir of ['rtl', 'ltr']) {
            const svg = rowsSvg(dir);
            const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="8" rx="4" fill="([^"]+)"( stroke="([^"]+)" stroke-width="1")?\/>/g)];
            assert.ok(rects.length > 100, `${dir}: ${rects.length} bars`);
            const lit = rects.filter((m) => m[6]);
            assert.equal(lit.length, 1, 'exactly one lit bar');
            assert.equal(lit[0][4], TOKENS['--accent-soft']);
            assert.equal(lit[0][6], TOKENS['--accent-ring']);
            for (const m of rects.filter((x) => !x[6])) {
                assert.ok([16, 24, 32, 48, 64].includes(Number(m[3])), `${dir}: length ${m[3]}`);
                assert.equal((Number(m[2]) - 8) % 24, 0, 'on a 24px row');
                assert.equal(m[4], PATTERN_INK);
            }
            // The lit bar sits in the reading-end third of the card: x < 400 in Arabic (the left), x > 800 in English.
            const x = Number(lit[0][1]) + (dir === 'rtl' ? 0 : 900);
            assert.ok(dir === 'rtl' ? x < 400 : x > 800, `${dir}: lit bar at x=${x}`);
        }
        assert.equal(rowsSvg('rtl'), rowsSvg('rtl'), 'the same on every machine');
    });

    it('is a function of the script alone: the composition is deterministic, and every character it prints is in the font', () => {
        assert.equal(composeHtml('ar', 'FONT'), composeHtml('ar', 'FONT'));
        assert.equal(specHash(), specHash());
        assert.ok(cardCodePoints().length > 40);
        assert.ok(composeHtml('ar', 'AAAA').includes('base64,AAAA'));
    });
});
