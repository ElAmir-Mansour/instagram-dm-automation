/**
 * The platform logos on the six public pages (L8).
 *
 * The marks come from simple-icons@16.33.0 (CC0 path data; the trademarks stay with their owners) and
 * are drawn from ONE inline sprite that sits right after `<body>` on every page, because the shared
 * footer uses it too. What a person can get wrong here, and what this pins:
 *
 *   - a path edited by hand, or a symbol that drifts from the package (a logo is a trademark: it is
 *     drawn exactly as its owner publishes it, or not at all);
 *   - a `<use>` that points at nothing, so a button carries an empty box;
 *   - a logo that is mirrored or transformed in RTL (arrows mirror, logos never do);
 *   - a logo with no word beside it (a glyph never replaces the platform's name, and a screen reader
 *     gets the name from real text because every glyph is aria-hidden);
 *   - a Arabic page with a different set of glyphs from the English one;
 *   - a platform colour: the glyphs are monochrome (DESIGN.md §2), painted only by the --logo-* tokens.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { siFacebook, siInstagram, siTiktok, siWhatsapp, siYoutube } from 'simple-icons';
import { renderSiteTemplate } from './publicPages.js';

const PAGES = ['landing', 'pricing', 'privacy', 'terms', 'data-deletion', '404'] as const;

const PLATFORMS = [
    { id: 'whatsapp', icon: siWhatsapp, ar: 'واتساب', en: 'WhatsApp' },
    { id: 'instagram', icon: siInstagram, ar: 'إنستجرام', en: 'Instagram' },
    { id: 'facebook', icon: siFacebook, ar: 'فيسبوك', en: 'Facebook' },
    { id: 'tiktok', icon: siTiktok, ar: 'تيك توك', en: 'TikTok' },
    { id: 'youtube', icon: siYoutube, ar: 'يوتيوب', en: 'YouTube' },
] as const;
const IDS: readonly string[] = PLATFORMS.map((p) => p.id);

const read = (p: string): string => readFileSync(`public/${p}.html`, 'utf8');
const noComments = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, '');
const HTML = new Map(PAGES.map((p) => [p, noComments(read(p))] as const));

// ─── Parsing ───────────────────────────────────────────────────────────────────────────────────

const SPRITE = /<svg id="plogos"[\s\S]*?<\/svg>/;

/** The `d` of each symbol in a page's sprite, by platform id, plus anything in a symbol that is not one `<path d>`. */
function spriteOf(html: string): { paths: Map<string, string>; strays: string[] } {
    const sprite = SPRITE.exec(html)?.[0] ?? '';
    const paths = new Map<string, string>();
    const strays: string[] = [];
    for (const m of sprite.matchAll(/<symbol id="plogo-([a-z]+)" viewBox="0 0 24 24">([\s\S]*?)<\/symbol>/g)) {
        const body = /^<path d="([^"]*)"\/>$/.exec(m[2]!);
        if (body) paths.set(m[1]!, body[1]!);
        else strays.push(`${m[1]}: ${m[2]}`);
    }
    return { paths, strays };
}

type Glyph = { cls: string; attrs: string; id: string; at: number; end: number };

/** Every `<svg class="plogo…">` in the markup, in the one shape the pages use. */
function glyphsOf(html: string): Glyph[] {
    const out: Glyph[] = [];
    for (const m of html.matchAll(/<svg class="(plogo[^"]*)"([^>]*)><use href="#plogo-([a-z]+)"\/><\/svg>/g)) {
        out.push({ cls: m[1]!, attrs: m[2]!, id: m[3]!, at: m.index!, end: m.index! + m[0].length });
    }
    return out;
}

/** What a reader sees right after a glyph: tags gone, whitespace collapsed, the first 70 characters. */
function textAfter(html: string, glyph: Glyph): string {
    return html
        .slice(glyph.end, glyph.end + 700)
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 70);
}

/** The two language documents of the landing page, as index ranges into the comment-free markup. */
function landingRanges(html: string): { ar: [number, number]; en: [number, number] } {
    const ar = html.indexOf('<article class="doc" data-doc-lang="ar"');
    const en = html.indexOf('<article class="doc" data-doc-lang="en"');
    const end = html.indexOf('</main>');
    assert.ok(ar > 0 && en > ar && end > en, 'both articles and </main> are present, in order');
    return { ar: [ar, en], en: [en, end] };
}

/** Which document a glyph is in: a language article, or the shared chrome around them. */
function regionOf(html: string, at: number): 'ar' | 'en' | 'chrome' {
    if (!html.includes('<article class="doc" data-doc-lang="ar"')) return 'chrome';
    const r = landingRanges(html);
    if (at >= r.ar[0] && at < r.ar[1]) return 'ar';
    if (at >= r.en[0] && at < r.en[1]) return 'en';
    return 'chrome';
}

function styleOf(html: string): string {
    return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every style rule in a stylesheet, descending into @media and @supports blocks. */
function rulesIn(css: string): Array<{ selectors: string[]; body: string }> {
    const out: Array<{ selectors: string[]; body: string }> = [];
    let i = 0;
    while (i < css.length) {
        const open = css.indexOf('{', i);
        if (open === -1) break;
        const head = css.slice(i, open).trim();
        let depth = 1;
        let j = open + 1;
        while (j < css.length && depth > 0) {
            if (css[j] === '{') depth++;
            else if (css[j] === '}') depth--;
            j++;
        }
        const body = css.slice(open + 1, j - 1);
        if (head.startsWith('@')) out.push(...rulesIn(body));
        else out.push({ selectors: head.split(',').map((x) => x.trim().replace(/\s+/g, ' ')), body });
        i = j;
    }
    return out;
}

// ─── The guards, as functions, so each can be shown a bad sample ───────────────────────────────────

const LOGO_INK = /^var\(--logo-(?:mono|mono-yt|on-accent)\)$/;
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;
const FLIPS = /(?<![-\w])(?:transform|rotate|scale|translate|writing-mode|direction|unicode-bidi)\s*:/;

/** What is wrong with the CSS rules that name `.plogo` or `.ptile`. */
function cssProblems(css: string): string[] {
    const problems: string[] = [];
    for (const rule of rulesIn(css)) {
        const sel = rule.selectors.join(', ');
        if (!/\.plogo|\.ptile/.test(sel)) continue;
        if (FLIPS.test(rule.body)) problems.push(`${sel}: transforms or flips (${rule.body.trim()})`);
        if (/:dir\(|\[dir|:lang\(|\[lang|html\[/.test(sel)) problems.push(`${sel}: is scoped by direction or language, which is how a logo gets mirrored`);
        for (const d of rule.body.matchAll(/(?<![-\w])fill\s*:\s*([^;}]+)/g)) {
            if (!LOGO_INK.test(d[1]!.trim())) problems.push(`${sel}: fill ${d[1]!.trim()} is not a --logo-* token`);
        }
        if (COLOUR_LITERAL.test(rule.body)) problems.push(`${sel}: a colour literal`);
        if (/\.ptile/.test(sel)) {
            for (const d of rule.body.matchAll(/background\s*:\s*([^;}]+)/g)) {
                if (!/^var\(--(?:surface-glass|brand-(?:instagram|facebook|tiktok|youtube)-soft)\)$/.test(d[1]!.trim())) {
                    problems.push(`${sel}: background ${d[1]!.trim()} is not a -soft tint`);
                }
            }
        }
    }
    return problems;
}

/** What is wrong with the markup of one page's logos. */
function markupProblems(html: string, region: (at: number) => 'ar' | 'en' | 'chrome'): string[] {
    const problems: string[] = [];
    const glyphs = glyphsOf(html);
    const stray = (html.match(/<svg class="plogo/g) ?? []).length;
    if (stray !== glyphs.length) problems.push(`${stray - glyphs.length} .plogo svg(s) not in the one shape (class, attributes, one <use>)`);
    for (const g of glyphs) {
        const where = `#plogo-${g.id} @${g.at}`;
        if (!/^ aria-hidden="true" focusable="false"$/.test(g.attrs)) problems.push(`${where}: must be exactly aria-hidden="true" focusable="false", got "${g.attrs}"`);
        if (/\b(?:transform|style|fill|stroke)=/.test(g.attrs)) problems.push(`${where}: carries a transform, style, fill or stroke`);
        const p = PLATFORMS.find((x) => x.id === g.id);
        if (!p) {
            problems.push(`${where}: not one of the five platforms`);
            continue;
        }
        const yt = / plogo-yt\b/.test(` ${g.cls}`);
        if (yt !== (g.id === 'youtube')) problems.push(`${where}: plogo-yt belongs on YouTube, and only there`);
        const text = textAfter(html, g);
        const at = region(g.at);
        const wants = at === 'ar' ? [p.ar] : at === 'en' ? [p.en] : [p.ar, p.en];
        for (const name of wants) if (!text.includes(name)) problems.push(`${where}: the text beside it ("${text}") does not name ${name}`);
    }
    return problems;
}

// ─── The tests ─────────────────────────────────────────────────────────────────────────────────

describe('platform logos — the sprite is simple-icons, byte for byte', () => {
    it('simple-icons is pinned to the exact version the paths were taken from', () => {
        const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { devDependencies: Record<string, string> };
        assert.equal(pkg.devDependencies['simple-icons'], '16.33.0', 'an exact pin, not a range');
        const installed = JSON.parse(readFileSync('node_modules/simple-icons/package.json', 'utf8')) as { version: string };
        assert.equal(installed.version, '16.33.0');
    });

    for (const page of PAGES) {
        it(`${page}: five symbols, each one <path> whose d equals the simple-icons export`, () => {
            const { paths, strays } = spriteOf(HTML.get(page)!);
            assert.deepEqual(strays, [], 'a symbol holds only its one path');
            assert.deepEqual([...paths.keys()].sort(), [...IDS].sort());
            for (const p of PLATFORMS) {
                assert.equal(paths.get(p.id), p.icon.path, `${page}: #plogo-${p.id} differs from simple-icons@16.33.0`);
            }
        });

        it(`${page}: the sprite is the first thing in <body>, hidden, and carries no colour`, () => {
            const html = HTML.get(page)!;
            assert.match(html, /<body>\s*<svg id="plogos" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">/);
            const sprite = SPRITE.exec(html)![0];
            assert.equal(/\b(?:fill|stroke|transform|style)=(?!"position:absolute")/.test(sprite), false, 'the symbols inherit their ink from CSS');
            assert.equal((html.match(/<svg id="plogos"/g) ?? []).length, 1, 'one sprite');
        });
    }

    it('the sprite is the same on all six pages (the shared footer relies on it being there)', () => {
        const reference = SPRITE.exec(HTML.get('landing')!)![0];
        for (const page of PAGES) assert.equal(SPRITE.exec(HTML.get(page)!)![0], reference, page);
    });
});

describe('platform logos — every use resolves, and every glyph is read from real text', () => {
    for (const page of PAGES) {
        it(`${page}: every href="#plogo-*" points at a symbol in this page's sprite`, () => {
            const html = HTML.get(page)!;
            const symbols = new Set([...spriteOf(html).paths.keys()]);
            const uses = [...html.matchAll(/href="#plogo-([a-z]+)"/g)].map((m) => m[1]!);
            assert.ok(uses.length >= 5, `${page}: the footer alone draws five glyphs`);
            for (const id of uses) assert.ok(symbols.has(id), `${page}: #plogo-${id} has no symbol`);
        });

        it(`${page}: every .plogo is aria-hidden, with text beside it that names the platform`, () => {
            const html = HTML.get(page)!;
            assert.deepEqual(markupProblems(html, (at) => regionOf(html, at)), []);
        });
    }

    it('the guard is not blind: it flags each fault it is for', () => {
        const ok = '<span>x</span><svg class="plogo" aria-hidden="true" focusable="false"><use href="#plogo-instagram"/></svg>إنستجرام';
        assert.deepEqual(markupProblems(ok, () => 'ar'), []);
        const bad: Array<[string, string]> = [
            ['no aria-hidden', ok.replace(' aria-hidden="true"', '')],
            ['not focusable=false', ok.replace(' focusable="false"', '')],
            ['no name beside it', ok.replace('إنستجرام', 'نص آخر')],
            ['another platform\'s name beside it', ok.replace('إنستجرام', 'فيسبوك')],
            ['a flip attribute', ok.replace('aria-hidden', 'transform="scale(-1,1)" aria-hidden')],
            ['plogo-yt on Instagram', ok.replace('class="plogo"', 'class="plogo plogo-yt"')],
            ['an unknown platform', ok.replace('plogo-instagram', 'plogo-telegram')],
        ];
        for (const [what, html] of bad) assert.notDeepEqual(markupProblems(html, () => 'ar'), [], what);
        assert.notDeepEqual(markupProblems(ok.replace('<use href="#plogo-instagram"/>', '<use href="#plogo-instagram"/><use href="#x"/>'), () => 'ar'), [], 'a second use');
    });
});

describe('platform logos — served the way src/index.ts serves them', () => {
    const WITH = { whatsappNumber: '966501234567', contactEmail: 'hello@example.com', eidCouponsExpire: null };
    const WITHOUT = { whatsappNumber: null, contactEmail: 'hello@example.com', eidCouponsExpire: null };
    /** What `grep -c 'href="#plogo-'` counts: the production check in the spec. */
    const uses = (html: string, id = '') => (html.match(new RegExp(`href="#plogo-${id}`, 'g')) ?? []).length;

    for (const lang of ['ar', 'en'] as const) {
        it(`landing (${lang}): 61 glyphs with a WhatsApp number, 56 without, and none of the missing ones is a WhatsApp mark`, () => {
            const src = read('landing');
            const full = renderSiteTemplate(src, WITH, lang);
            const bare = renderSiteTemplate(src, WITHOUT, lang);
            // Each language: 15 (buttons, rows, samples) + 13 in the L9 diagrams (the flow chips: 2 + 3 + 4, and
            // the platform map's four row heads). Two languages, plus the footer's five.
            assert.equal(uses(full), 61, 'two languages x 28, plus the footer\'s five');
            assert.equal(uses(full, 'whatsapp'), 5, 'hero and contact in each language, and the footer');
            assert.equal(uses(bare), 56);
            assert.equal(uses(bare, 'whatsapp'), 0, 'a link that is removed takes its glyph with it');
            assert.equal(bare.includes('class="foot-wa"'), false);
        });
    }

    for (const page of PAGES.filter((p) => p !== 'landing')) {
        it(`${page}: the footer's five glyphs, four without a WhatsApp number`, () => {
            const src = read(page);
            assert.equal(uses(renderSiteTemplate(src, WITH)), 5);
            assert.equal(uses(renderSiteTemplate(src, WITHOUT)), 4);
        });
    }
});

describe('platform logos — nothing mirrors, transforms or colours a logo', () => {
    for (const page of PAGES) {
        it(`${page}: the rules naming .plogo or .ptile only size and ink them, with the --logo-* tokens`, () => {
            assert.deepEqual(cssProblems(styleOf(read(page))), []);
        });
    }

    it('the guard is not blind: it flags each fault it is for', () => {
        const ok = '.plogo { inline-size: 1rem; fill: var(--logo-mono); } .ptile-instagram { background: var(--brand-instagram-soft); }';
        assert.deepEqual(cssProblems(ok), []);
        for (const bad of [
            '.plogo { transform: scaleX(-1); }',
            ':dir(rtl) .plogo { transform: scaleX(-1); }',
            'html[dir=rtl] .plogo { margin: 0; }',
            '.plogo { fill: #25d366; }',
            '.plogo { fill: currentColor; }',
            '.plogo { fill: var(--accent); }',
            '.btn > .plogo { fill: rgb(0 0 0); }',
            '.ptile { transform: rotate(3deg); }',
            '.ptile-tiktok { background: var(--brand-tiktok); }',
            '.ptile { background: #25f4ee; }',
            '.plogo { direction: ltr; }',
        ]) {
            assert.notDeepEqual(cssProblems(bad), [], bad);
        }
    });

    it('the three tokens exist in the shared chrome with the values the brands allow, in the three-selector shape', () => {
        const css = styleOf(read('landing'));
        /** The declarations of the one block whose selector matches and whose first declaration is --logo-mono. */
        const pick = (selector: RegExp) => {
            const m = new RegExp(`${selector.source}\\s*\\{(?=\\s*--logo-mono:)`).exec(css);
            assert.ok(m, `no --logo-* block under ${selector}`);
            const from = m.index + m[0].length;
            const body = css.slice(from, css.indexOf('}', from));
            const v = Object.fromEntries([...body.matchAll(/--([a-z-]+)\s*:\s*([^;]+);/g)].map((x) => [x[1]!, x[2]!.trim().toLowerCase()]));
            return [v['logo-mono'], v['logo-mono-yt'], v['logo-on-accent']];
        };
        assert.deepEqual(pick(/:root,\s*:root\[data-theme='dark'\]/), ['#ffffff', '#ffffff', '#000000'], 'dark');
        const light = ['#000000', '#282828', '#ffffff'];
        assert.deepEqual(pick(/@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme='dark'\]\)/), light, 'light, from the OS');
        assert.deepEqual(pick(/:root\[data-theme='light'\]/), light, 'light, pinned');
        assert.match(css, /:root\s*\{\s*--lp-logo:\s*1\.5rem;\s*\}/);
        const base = rulesIn(css).find((r) => r.selectors.length === 1 && r.selectors[0] === '.plogo')!;
        assert.ok(base, 'the base .plogo rule');
        assert.match(base.body, /inline-size:\s*var\(--lp-logo\)/);
        assert.match(base.body, /block-size:\s*var\(--lp-logo\)/);
        assert.match(base.body, /fill:\s*var\(--logo-mono\)/);
        assert.match(base.body, /flex:\s*none/);
        assert.match(rulesIn(css).find((r) => r.selectors[0] === '.plogo-yt')!.body, /fill:\s*var\(--logo-mono-yt\)/);
    });

    it('the primary button paints its glyph with --logo-on-accent, at 20px, and moves it by margin, not by direction', () => {
        const rule = rulesIn(styleOf(read('landing'))).find((r) => r.selectors.includes('.btn > .plogo'));
        assert.ok(rule);
        assert.match(rule.body, /fill:\s*var\(--logo-on-accent\)/);
        assert.match(rule.body, /--lp-logo:\s*1\.25rem/);
        assert.match(rule.body, /margin-inline-end:\s*var\(--space-2\)/);
    });
});

describe('platform logos — where they sit on the landing page', () => {
    const html = HTML.get('landing')!;
    const ranges = landingRanges(html);
    const docs = { ar: html.slice(...ranges.ar), en: html.slice(...ranges.en) };

    it('the same glyphs, in the same numbers, in Arabic and in English', () => {
        const tally = (doc: string) => {
            const t: Record<string, number> = {};
            for (const g of glyphsOf(doc)) t[g.id] = (t[g.id] ?? 0) + 1;
            return t;
        };
        const ar = tally(docs.ar);
        const en = tally(docs.en);
        assert.deepEqual(ar, en);
        assert.equal(glyphsOf(docs.ar).length, glyphsOf(docs.en).length);
        assert.ok(glyphsOf(docs.ar).length >= 14, 'the buttons, the rows and the samples are all there');
        assert.equal(ar['whatsapp'], 2, 'the hero button and the contact button');
        assert.equal(ar['youtube'], 3, 'the platform row, the Monteur diagram\'s chip and the platform map\'s row: there is still no YouTube link in the samples');
    });

    it('the WhatsApp buttons carry the glyph first and keep the word in the label', () => {
        for (const [lang, doc] of Object.entries(docs)) {
            const buttons = [...doc.matchAll(/<a class="btn btn-primary" data-when="whatsapp"[^>]*>([\s\S]*?)<\/a>/g)];
            assert.equal(buttons.length, 2, `${lang}: hero and contact`);
            for (const b of buttons) {
                assert.match(b[1]!, /^<svg class="plogo" aria-hidden="true" focusable="false"><use href="#plogo-whatsapp"\/><\/svg>/, lang);
                const label = b[1]!.replace(/<svg[\s\S]*?<\/svg>/, '').trim();
                assert.ok(label.includes(lang === 'ar' ? 'واتساب' : 'WhatsApp'), `${lang}: "${label}" keeps the word`);
            }
        }
        // The hero's two buttons are matched by exact class in landingTruth: no class was added.
        assert.equal((html.match(/<a class="btn btn-primary" data-when="whatsapp"/g) ?? []).length, 4);
    });

    it('the four platform rows each lead with a 40px tile in their own tint, in the order IG, FB, TikTok, YouTube', () => {
        for (const [lang, doc] of Object.entries(docs)) {
            const list = /<ul class="card reqs">[\s\S]*?<\/ul>/.exec(doc)![0];
            const h3s = [...list.matchAll(/<h3>([\s\S]*?)<\/h3>/g)].map((m) => m[1]!);
            const tiles = h3s.filter((h) => h.startsWith('<span class="ptile'));
            assert.equal(tiles.length, 4, lang);
            assert.deepEqual(
                tiles.map((h) => /ptile-([a-z]+)">/.exec(h)![1]),
                ['instagram', 'facebook', 'tiktok', 'youtube'],
                lang
            );
            for (const h of tiles) {
                const id = /ptile-([a-z]+)"/.exec(h)![1]!;
                const p = PLATFORMS.find((x) => x.id === id)!;
                assert.ok(h.includes(`<use href="#plogo-${id}"/>`), `${lang}: ${id} tile draws its own glyph`);
                assert.ok(h.endsWith(`</span>${lang === 'ar' ? p.ar : p.en}`), `${lang}: ${id} tile is followed by the platform's name`);
            }
            // The Studio, the Monteur and the Infographics are not platforms: no mark.
            assert.equal(h3s.length - tiles.length, 3, lang);
            assert.ok(h3s.filter((h) => !h.startsWith('<span class="ptile')).every((h) => !h.includes('<svg')), lang);
        }
    });

    it('the tile is 40px and a rounded square, and the rows lay tile and name out with the gap token', () => {
        const rules = rulesIn(styleOf(read('landing')));
        const tile = rules.find((r) => r.selectors.includes('.ptile'))!;
        assert.match(tile.body, /inline-size:\s*2\.5rem/);
        assert.match(tile.body, /block-size:\s*2\.5rem/);
        const h3 = rules.find((r) => r.selectors.includes('.reqs h3'))!;
        assert.match(h3.body, /display:\s*flex/);
        assert.match(h3.body, /gap:\s*var\(--space-3\)/);
        for (const id of ['instagram', 'facebook', 'tiktok', 'youtube']) {
            const t = rules.find((r) => r.selectors.includes(`.ptile-${id}`))!;
            assert.ok(t, id);
            assert.match(t.body, new RegExp(`background:\\s*var\\(--brand-${id}-soft\\)`), id);
        }
    });

    it('the samples: the links to our accounts and the covers\' captions carry 16px glyphs', () => {
        const rules = rulesIn(styleOf(read('landing')));
        for (const sel of ['.live a > .plogo', '.reel figcaption .plogo']) {
            const r = rules.find((x) => x.selectors.includes(sel));
            assert.ok(r, sel);
            assert.match(r.body, /--lp-logo:\s*1rem/, sel);
        }
        for (const [lang, doc] of Object.entries(docs)) {
            const live = /<ul class="live">[\s\S]*?<\/ul>/.exec(doc)![0];
            const links = [...live.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]!);
            assert.equal(links.length, 4, lang);
            assert.deepEqual(links.map((l) => (/#plogo-([a-z]+)/.exec(l) ?? [])[1]), ['instagram', 'instagram', 'tiktok', undefined], `${lang}: the course link has no mark`);
            const caps = [...doc.matchAll(/<figcaption>([\s\S]*?)<\/figcaption>/g)].map((m) => m[1]!).filter((c) => c.includes('<svg'));
            assert.equal(caps.length, 4, `${lang}: the four captions that name a platform`);
        }
    });
});

describe('platform logos — the shared footer', () => {
    const FOLLOW_ORDER = [
        ['instagram', 'https://www.instagram.com/elamir.mansour/'],
        ['tiktok', 'https://www.tiktok.com/@elamir_mansour'],
        ['facebook', 'https://www.facebook.com/ElAmirMahmoudMansour'],
        ['youtube', 'https://www.youtube.com/@elamir'],
    ] as const;

    for (const page of PAGES) {
        it(`${page}: Follow has the four accounts as simple-icons marks with real-text names, and no hand-drawn glyph is left`, () => {
            const html = HTML.get(page)!;
            const follow = /<div class="foot-social">[\s\S]*?<\/div>/.exec(html)![0];
            const anchors = [...follow.matchAll(/<a href="([^"]+)" target="_blank" rel="noopener noreferrer">([\s\S]*?)<\/a>/g)];
            assert.deepEqual(anchors.map((a) => a[1]), FOLLOW_ORDER.map((f) => f[1]));
            anchors.forEach((a, i) => {
                const [id] = FOLLOW_ORDER[i]!;
                const p = PLATFORMS.find((x) => x.id === id)!;
                assert.ok(a[2]!.startsWith(`<svg class="plogo${id === 'youtube' ? ' plogo-yt' : ''}" aria-hidden="true" focusable="false"><use href="#plogo-${id}"/></svg>`), `${page}: ${id}`);
                assert.ok(a[2]!.includes(`<bdi class="t-ar" lang="ar">${p.ar}</bdi>`) && a[2]!.includes(`>${p.en}</bdi>`), `${page}: ${id} has its name in both languages`);
            });
            assert.equal(/stroke=|<rect|<circle/.test(follow), false, `${page}: the old outline glyphs are gone`);
        });

        it(`${page}: the footer's WhatsApp link carries the glyph before its label`, () => {
            const html = HTML.get(page)!;
            const wa = /<a class="foot-wa"[^>]*>([\s\S]*?)<\/a>/.exec(html)![1]!;
            assert.ok(wa.startsWith('<svg class="plogo" aria-hidden="true" focusable="false"><use href="#plogo-whatsapp"/></svg><bdi class="t-ar"'));
            assert.ok(wa.includes('واتساب') && wa.includes('WhatsApp'));
        });
    }

    it('the footer sizes its marks with the token: 20px in Follow, 16px beside the WhatsApp label', () => {
        const rules = rulesIn(styleOf(read('landing')));
        assert.match(rules.find((r) => r.selectors.includes('.pagefoot .foot-social .plogo'))!.body, /--lp-logo:\s*1\.25rem/);
        const wa = rules.find((r) => r.selectors.includes('.pagefoot .foot-wa .plogo'))!;
        assert.match(wa.body, /--lp-logo:\s*1rem/);
        assert.match(wa.body, /margin-inline-end:\s*var\(--space-2\)/);
    });
});
