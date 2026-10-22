/**
 * DESIGN.md and tokens.css must say the same thing, and the logo must not move.
 *
 * DESIGN.md §2 is a copy of dashboard/css/tokens.css, written so that a person can read it. A copy
 * with nothing checking it is a second palette that drifts: the previous DESIGN.md still said
 * `--accent` was Apple's blue two palettes after it stopped being. So every row of §2's tables is
 * parsed here and compared with the value tokens.css actually resolves to in that theme, and every
 * colour token in tokens.css must have a row. Edit one without the other and this fails.
 *
 * The second job is the logo. Since B5 it is the Kufi «رد» mark (IDENTITY.md section 2), which replaced Lucide's zap on a
 * #0071e3 tile: the mark paints two tokens per theme, the favicon is a pinned file (the kit's 16px micro cut), the manifest's
 * icon list is pinned, and the old picture may not come back anywhere. The constants below are edited on purpose, in a PR that
 * changes the logo again; scripts/build-brand-icons.mjs --check holds the icon files themselves to the pixel.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (p: string): string => readFileSync(p, 'utf8');

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

// ─── tokens.css, parsed the way scripts/check-contrast.mjs parses it ───────────────────────────
const cssNoComments = read('dashboard/css/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');

function blockOf(re: RegExp): Record<string, string> {
    const m = cssNoComments.match(re);
    assert.ok(m && m.index !== undefined, `tokens.css: no block matches ${re}`);
    const from = m.index + m[0].length;
    let depth = 1;
    let i = from;
    while (i < cssNoComments.length && depth > 0) {
        const ch = cssNoComments[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    const out: Record<string, string> = {};
    for (const x of cssNoComments.slice(from, i - 1).matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
        out[x[1] as string] = (x[2] as string).trim();
    }
    return out;
}

const base = blockOf(/:root\s*\{/);
const darkBlock = blockOf(/:root,\s*:root\[data-theme='dark'\]\s*\{/);
const lightMedia = blockOf(/:root:not\(\[data-theme='dark'\]\)\s*\{/);
const lightPinned = blockOf(/:root\[data-theme='light'\]\s*\{/);
const THEMES: Record<'dark' | 'light', Record<string, string>> = {
    dark: { ...base, ...darkBlock },
    light: { ...base, ...darkBlock, ...lightMedia, ...lightPinned },
};

/** Every colour literal in a value, in order and normalised: hex lowercased, rgba numbers parsed. */
function colours(value: string): string[] {
    return [...value.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => {
        const lit = m[0];
        if (lit.startsWith('#')) return lit.toLowerCase();
        const nums = (lit.match(/[\d.]+/g) ?? []).map((n) => String(Number(n)));
        return `rgba(${nums.join(',')})`;
    });
}

/**
 * Tokens that hold a colour literal but are not documented as a row in §2, with why. Shadows are
 * black and diffuse (§6) and are not a palette; the chevron is a data URI whose stroke is
 * `--chart-tick`; the `--border-*` tone edges are `color-mix` of a status token.
 */
const NOT_A_ROW = (name: string): boolean => /^elev-/.test(name) || name === 'select-chevron' || /^border-(info|warning|danger|success)$/.test(name);

// ─── DESIGN.md §2, parsed ──────────────────────────────────────────────────────────────────────
const design = read('DESIGN.md');

function sectionOf(md: string, n: number): string {
    const start = md.indexOf(`\n## ${n}. `);
    assert.ok(start >= 0, `DESIGN.md has no "## ${n}." heading`);
    const next = md.indexOf(`\n## ${n + 1}. `, start + 1);
    return md.slice(start, next === -1 ? undefined : next);
}

type Row = { token: string; dark: string; light: string };
function rowsOf(section: string): Row[] {
    const rows: Row[] = [];
    for (const line of section.split('\n')) {
        if (!line.startsWith('|')) continue;
        const cells = line.split('|').slice(1, -1).map((c) => c.trim());
        const token = /^`--([a-z0-9-]+)`$/.exec(cells[0] ?? '')?.[1];
        if (!token) continue; // the header and the separator row
        rows.push({ token, dark: cells[1] ?? '', light: cells[2] ?? '' });
    }
    return rows;
}

const section2 = sectionOf(design, 2);
const rows = rowsOf(section2);

describe('DESIGN.md: shape', () => {
    it('keeps the nine sections, in order', () => {
        const titles = [...design.matchAll(/^## (\d)\. (.+)$/gm)].map((m) => `${m[1]}. ${m[2]}`);
        assert.deepEqual(titles, [
            '1. Visual Theme & Atmosphere',
            '2. Color Palette & Roles',
            '3. Typography Rules',
            '4. Component Stylings',
            '5. Layout Principles',
            '6. Depth & Elevation',
            '7. Do\'s and Don\'ts',
            '8. Responsive Behavior',
            '9. Agent Prompt Guide',
        ]);
    });

    it('is no longer a draft, and says the logo is the Kufi «رد» mark and nothing is frozen', () => {
        assert.equal(/\bDRAFT\b/.test(design), false);
        assert.ok(design.includes('### Mark\n\n**Kufi «رد»**'));
        assert.ok(design.includes('### The logo mark: Kufi «رد»'));
        assert.equal(/FROZEN|frozen until|until TikTok accepts/i.test(design), false, 'the freeze is lifted: no section may still say the logo waits for TikTok');
    });
});

describe('DESIGN.md §2 = tokens.css', () => {
    it('parses a real table (a regex that matches nothing would pass every test below)', () => {
        assert.ok(rows.length >= 50, `only ${rows.length} rows parsed from §2`);
    });

    for (const theme of ['dark', 'light'] as const) {
        it(`every documented ${theme} value is the value tokens.css resolves to`, () => {
            const wrong: string[] = [];
            for (const row of rows) {
                const actual = THEMES[theme][row.token];
                if (actual === undefined) {
                    wrong.push(`--${row.token}: documented, but tokens.css has no such token`);
                    continue;
                }
                const sameAsDark = /^`?=`?$/.test(row.light);
                const cell = theme === 'dark' || sameAsDark ? row.dark : row.light;
                const documented = colours(cell);
                const expected = colours(actual);
                if (expected.length === 0) {
                    wrong.push(`--${row.token}: tokens.css holds no colour literal (${actual}); it does not belong in a table`);
                } else if (JSON.stringify(documented) !== JSON.stringify(expected)) {
                    wrong.push(`--${row.token} (${theme}): DESIGN.md says [${documented.join(', ')}], tokens.css says [${expected.join(', ')}]`);
                }
            }
            assert.deepEqual(wrong, []);
        });
    }

    it('every colour token in tokens.css has a row', () => {
        const documented = new Set(rows.map((r) => r.token));
        const missing = new Set<string>();
        for (const theme of ['dark', 'light'] as const) {
            for (const [name, value] of Object.entries(THEMES[theme])) {
                if (colours(value).length > 0 && !NOT_A_ROW(name) && !documented.has(name)) missing.add(name);
            }
        }
        assert.deepEqual([...missing], [], 'a colour token with no DESIGN.md row is a palette nobody reads');
    });

    it('no token is documented twice', () => {
        const seen = new Set<string>();
        const dupes = rows.map((r) => r.token).filter((t) => (seen.has(t) ? true : (seen.add(t), false)));
        assert.deepEqual(dupes, []);
    });

    it('the two light blocks (OS-asked and pinned) are verbatim copies of each other', () => {
        assert.deepEqual(lightMedia, lightPinned, 'the media-query block and [data-theme=light] must not drift');
    });

    it('the measured numbers in §2 are the ones check:contrast prints', () => {
        const out = execFileSync('node', ['scripts/check-contrast.mjs'], { encoding: 'utf8' });
        const dark = /tightest ([\d.]+):1 dark/.exec(out)?.[1];
        const light = /; ([\d.]+):1 light/.exec(out)?.[1];
        assert.ok(dark && light, `could not read the tightest pairs from: ${out}`);
        assert.ok(section2.includes(`${dark}:1 dark`), `§2 must say the worst dark text pair is ${dark}:1`);
        assert.ok(section2.includes(`${light}:1`), `§2 must say the worst light text pair is ${light}:1`);
        const pairs = /(\d+) text pairs clear/.exec(out)?.[1];
        assert.ok(pairs && section2.includes(`${pairs} text pairs`), `§2 must say ${pairs} text pairs are measured`);
    });
});

// ─── The logo: Kufi «رد» ───────────────────────────────────────────────────────────────────────
//
// Constants, not reads: the point is that changing any of them is a deliberate edit of this file.
const MARK = {
    /** IDENTITY.md section 2: Cardamom for dark UI and every icon, Ink for light UI. */
    dark: { tile: '#bcde70', glyph: '#141610' },
    light: { tile: '#1a1c15', glyph: '#bcde70' },
    /** The master's glyph: the د and the ر, two subpaths, no dot. Ink 18.4% of the tile. */
    glyph: 'M72 56H136V152H40V120H104V88H72ZM168 56H200V178.51L158.51 220H113.25L168 165.25Z',
    /** sha256 of public/favicon.svg: the kit's mark-micro-16.svg, the 16px cut, byte for byte. */
    faviconSha256: '3429ef12281c94d8885bc581d801c26fbff94d4669ca3b7fc7993ed3d681e4b0',
    /** The dark page, which is what the manifest's two colours are. */
    manifestColour: '#111210',
};

describe('the logo mark is the Kufi «رد» drawing, in the colourways IDENTITY.md section 2 gives it', () => {
    it('--mark-tile and --mark-glyph are Cardamom in dark and Ink in light, and the old lit gradient is gone', () => {
        assert.equal(darkBlock['mark-tile'], MARK.dark.tile);
        assert.equal(darkBlock['mark-glyph'], MARK.dark.glyph);
        for (const [name, block] of Object.entries({ 'light (media)': lightMedia, 'light (pinned)': lightPinned })) {
            assert.equal(block['mark-tile'], MARK.light.tile, `${name}: --mark-tile`);
            assert.equal(block['mark-glyph'], MARK.light.glyph, `${name}: --mark-glyph`);
        }
        // Not in the theme-independent block: a mark that is the same in both themes is the one the freeze pinned.
        assert.equal(base['mark-tile'], undefined);
        assert.equal(base['mark-glyph'], undefined);
        for (const block of [base, darkBlock, lightMedia, lightPinned]) assert.equal(block['mark-tile-lit'], undefined, 'the new tile is flat: no gradient layer');
        assert.equal(/--mark-tile-lit/.test(read('dashboard/css/styles.css')), false);
    });

    it('.logo-mark is 32px and .login-mark 64px: the sizes at which every edge of the master lands on a whole pixel', () => {
        const css = read('dashboard/css/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
        const rules = rulesIn(css);
        const decl = (sel: string): string => rules.filter((r) => r.selectors.includes(sel)).map((r) => r.body).join(';');
        assert.match(decl('.logo-mark'), /inline-size:\s*32px;\s*block-size:\s*32px/);
        assert.match(decl('.login-mark'), /inline-size:\s*64px;\s*block-size:\s*64px/);
        assert.equal(/(?:^|[;\s])(?:width|height):\s*(?:38|62)px/.test(decl('.logo-mark') + decl('.login-mark')), false, 'the old sizes put every edge between pixels');
    });

    it('the tile and the glyph are painted from the mark tokens, and no rule that can reach the mark paints it from the accent, a literal, a gradient or a shadow', () => {
        const css = read('dashboard/css/styles.css').replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
        const rules = rulesIn(css);
        const paint = (sel: string): string => rules.filter((r) => r.selectors.includes(sel)).map((r) => r.body).join(';');
        assert.match(paint('.mark-tile'), /(^|[;\s])fill:\s*var\(--mark-tile\)/, '.mark-tile paints --mark-tile');
        assert.match(paint('.mark-glyph'), /(^|[;\s])fill:\s*var\(--mark-glyph\)/, '.mark-glyph paints --mark-glyph');

        // EVERY rule that can reach the mark, in any block, is free of the accent family. The first-match version of this test passed
        // a `@media { .logo-mark { background: var(--gradient-brand) } }` appended further down the file.
        const REACHES_THE_MARK = /logo-mark|login-mark|sidebar-logo|login-logo|mark-tile|mark-glyph/;
        const ACCENT_FAMILY = /var\(--(?:accent[a-z-]*|gradient-brand[a-z-]*|text-on-accent|chart-accent)\)/;
        const touching = rules.filter((r) => r.selectors.some((x) => REACHES_THE_MARK.test(x)));
        assert.ok(touching.length >= 5, `only ${touching.length} rules reach the mark; the scan is not reading the stylesheet`);
        const offenders = touching.filter((r) => ACCENT_FAMILY.test(r.body)).map((r) => `${r.selectors.join(', ')} { ${r.body.trim()} }`);
        assert.deepEqual(offenders, [], 'a rule paints the mark from the accent');
        const literal = touching.filter((r) => /(?:background|color|fill|stroke)[a-z-]*:[^;]*(?:#[0-9a-fA-F]{3,8}\b|rgba?\()/.test(r.body)).map((r) => r.selectors.join(', '));
        assert.deepEqual(literal, [], 'a rule paints the mark from a colour literal instead of the mark tokens');
        // IDENTITY.md Never: no gradient, gloss, shadow or 3D effect, and nothing that mirrors it.
        const effects = touching.filter((r) => /(?:gradient|box-shadow|filter|drop-shadow|transform|text-shadow)/.test(r.body)).map((r) => r.selectors.join(', '));
        assert.deepEqual(effects, [], 'the mark takes no gradient, shadow, filter or transform');
    });

    it('the login and the sidebar are the master geometry, in markup that paints before any script runs', () => {
        const html = read('dashboard/index.html');
        for (const cls of ['login-mark', 'logo-mark']) {
            const m = new RegExp(`<div class="${cls}">(<svg [^>]*>[\\s\\S]*?</svg>)</div>`).exec(html);
            assert.ok(m, `${cls}: an inline svg`);
            const svg = m[1] as string;
            assert.ok(svg.includes('viewBox="0 0 256 256"') && svg.includes('aria-hidden="true"'), `${cls}: the 256 grid, decorative`);
            assert.ok(svg.includes('<rect class="mark-tile" width="256" height="256" rx="64"/>'), `${cls}: the tile, radius 2 modules`);
            assert.ok(svg.includes(`<path class="mark-glyph" d="${MARK.glyph}"/>`), `${cls}: the master glyph`);
            assert.equal((svg.match(/<path/g) ?? []).length, 1, `${cls}: one path, so the د and the ر and nothing else (never a dot)`);
        }
    });

    it('public/favicon.svg is the kit\'s 16px micro cut, byte for byte, with no light-mode swap', () => {
        const svg = readFileSync('public/favicon.svg');
        assert.equal(createHash('sha256').update(svg).digest('hex'), MARK.faviconSha256);
        const text = svg.toString('utf8');
        assert.match(text, /<rect width="16" height="16" rx="4" fill="#BCDE70"\/>/);
        assert.match(text, /<path fill="#141610" d="M5 3H9V9H3V7H7V5H5ZM11 3H13V11L11 13H8L11 10Z"\/>/);
        assert.equal(/prefers-color-scheme|<style|@media/.test(text), false, 'the Ink tile at 16px vanishes on a dark tab strip: Cardamom at every size');
    });

    it('the manifest names the four icons the build wrote, and the dark page for its two colours', () => {
        const manifest = JSON.parse(read('public/site.webmanifest')) as { icons: Array<{ src: string; sizes: string; type: string; purpose: string }>; theme_color: string; background_color: string };
        assert.equal(manifest.theme_color, MARK.manifestColour);
        assert.equal(manifest.background_color, MARK.manifestColour);
        assert.equal(manifest.theme_color, THEMES.dark['surface-page']?.toLowerCase());
        const shape = manifest.icons.map((i) => [i.src.replace(/\.[0-9a-f]{8}\./, '.<sha8>.'), i.sizes, i.type, i.purpose]);
        assert.deepEqual(shape, [
            ['/brand/icon-192.<sha8>.png', '192x192', 'image/png', 'any'],
            ['/brand/icon-512.<sha8>.png', '512x512', 'image/png', 'any'],
            ['/brand/icon-maskable-512.<sha8>.png', '512x512', 'image/png', 'maskable'],
            ['/brand/mark.<sha8>.svg', 'any', 'image/svg+xml', 'any'],
        ]);
    });

    it('neither the Lucide zap nor #0071e3 is the brand mark anywhere: no page, script, stylesheet, icon file or manifest names either', () => {
        const ZAP_PATH = 'M4 14a1 1 0 0 1-.78-1.63';
        const OLD_FAVICON_POLYGON = '13 2 3 14 12 14 11 22 21 10 12 10 13 2';
        const BRAND_BOX = /class="[^"]*\b(?:logo-mark|login-mark|welcome-brand|sidebar-logo|login-logo|wordmark|foot-mark)\b[^"]*"[^>]*>(?:(?!<\/(?:div|span|a|header)>)[\s\S])*?data-lucide="zap"/;
        const hits: string[] = [];
        const walk = (dir: string): void => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const f = `${dir}/${e.name}`;
                if (e.isDirectory()) {
                    if (e.name === 'samples') continue;
                    walk(f);
                    continue;
                }
                // The two test files that name the old blue on purpose: this one, and the icon guard's, whose mutation puts it in a manifest.
                if (!/\.(css|js|html|svg|webmanifest|ts|mjs|json)$/.test(e.name) || f.endsWith('src/dashboard/design-md.test.ts') || f.endsWith('scripts/build-brand-icons.test.mjs')) continue;
                const text = read(f);
                // icons.js is the Lucide subset: `zap` is a real icon there (the inbox's "hot" badge), never the logo.
                if (/#0071e3/i.test(text)) hits.push(`${f}: #0071e3`);
                if (f !== 'dashboard/js/icons.js' && text.includes(ZAP_PATH)) hits.push(`${f}: the Lucide zap path`);
                if (text.includes(OLD_FAVICON_POLYGON)) hits.push(`${f}: the old favicon's polygon`);
                if (BRAND_BOX.test(text)) hits.push(`${f}: data-lucide="zap" inside a brand mark`);
            }
        };
        for (const d of ['dashboard', 'public', 'src', 'scripts']) walk(d);
        for (const f of ['preview.html', 'preview-dark.html']) {
            const text = read(f);
            if (/#0071e3/i.test(text) || text.includes(ZAP_PATH) || /mark-tile-lit/.test(text)) hits.push(f);
        }
        assert.deepEqual(hits, [], 'the old mark is back somewhere');
    });
});

// ─── The rest of the palette swap's loose ends ─────────────────────────────────────────────────
describe('nothing old is left behind in the pages', () => {
    const pages = ['dashboard/index.html', 'dashboard/eid.html', ...['landing', 'pricing', 'privacy', 'terms', 'data-deletion', '404'].map((p) => `public/${p}.html`)];

    it('the browser-chrome theme-color follows --surface-page in both themes', () => {
        for (const page of pages) {
            const metas = [...read(page).matchAll(/<meta\b[^>]*name="theme-color"[^>]*>/g)].map((m) => m[0]);
            assert.equal(metas.length, 2, `${page}: expected a dark and a light theme-color`);
            for (const tag of metas) {
                const scheme = /prefers-color-scheme:\s*(dark|light)/.exec(tag)?.[1] as 'dark' | 'light' | undefined;
                const content = /content="([^"]+)"/.exec(tag)?.[1];
                assert.ok(scheme && content, `${page}: unreadable ${tag}`);
                assert.equal(content.toLowerCase(), (THEMES[scheme]['surface-page'] as string).toLowerCase(), `${page}: ${scheme} theme-color`);
            }
        }
    });

    it('no page carries the pre-HIG indigo, or a colour literal in a var() fallback', () => {
        const fallback = /var\(--[a-z0-9-]+,\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))\)/;
        for (const page of pages) {
            const html = read(page);
            assert.equal(/#4f46e5|#14182a|#4338ca/i.test(html), false, `${page}: an indigo literal is back`);
            const css = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
            assert.equal(fallback.test(css), false, `${page}: a colour literal in a var() fallback is a second palette`);
        }
    });

    it('the landing glow is the one DESIGN.md §6 names (.55 dark / .35 light)', () => {
        const glows = [...read('public/landing.html').matchAll(/--lp-glow:\s*([\d.]+);/g)].map((m) => m[1]);
        assert.deepEqual(glows, ['0.55', '0.35'], 'dark first, then the light peer');
        assert.ok(design.includes('`--lp-glow` .55 dark / .35 light'), 'DESIGN.md §6 states the glow');
    });

    it('the charts take their series colour from --chart-accent, not the (near-black, in light) --accent', () => {
        const charts = read('dashboard/js/charts.js');
        assert.equal((charts.match(/opts\.token \|\| '--chart-accent'/g) ?? []).length, 3, 'the sparkline, the line chart and the compared bars');
        assert.equal(/opts\.token \|\| '--accent'/.test(charts), false);
        const growth = read('dashboard/js/pages/growth.js');
        assert.ok(growth.includes("token: '--chart-accent'"), 'the audience split and the trend line');
        assert.equal(/token: '--accent'/.test(growth), false);
        const css = read('dashboard/css/styles.css');
        for (const level of [1, 2, 3, 4]) {
            const body = new RegExp(`\\.heat-${level} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
            assert.match(body, /var\(--chart-accent\)/, `.heat-${level}`);
            assert.doesNotMatch(body, /var\(--accent\)/, `.heat-${level}`);
        }
    });

    it('the dashboard scripts hold no literal accent', () => {
        for (const file of ['dashboard/js/charts.js', 'dashboard/js/pages/growth.js']) {
            assert.equal(/#0071e3|#aeaeb2|#4f46e5/i.test(read(file)), false, file);
        }
    });
});

// ─── preview.html and preview-dark.html ────────────────────────────────────────────────────────
//
// Two plain static files that cannot read a build step, so the only way they stay one catalog is a
// check: the dark file is the light file with six known spots swapped, and nothing else.
describe('preview.html and preview-dark.html', () => {
    const light = read('preview.html');
    const dark = read('preview-dark.html');
    const SWAPS: Array<[string, string]> = [
        ['design preview, LIGHT', 'design preview, DARK'],
        ['<html lang="ar" dir="rtl" data-theme="light">', '<html lang="ar" dir="rtl" data-theme="dark">'],
        ['<meta name="color-scheme" content="light">', '<meta name="color-scheme" content="dark">'],
        ['<title>AutoReply Pro · preview · light</title>', '<title>AutoReply Pro · preview · dark</title>'],
        ['<span id="theme-name">light</span>', '<span id="theme-name">dark</span>'],
        ['<a href="preview-dark.html">Dark preview</a>', '<a href="preview.html">Light preview</a>'],
    ];

    it('the dark file is the light file with exactly those six spots swapped', () => {
        let expected = light;
        for (const [from, to] of SWAPS) {
            assert.equal(expected.split(from).length - 1, 1, `preview.html must contain "${from}" exactly once`);
            expected = expected.replace(from, to);
        }
        assert.equal(dark, expected, 'preview-dark.html has drifted from preview.html');
    });

    it('both load tokens.css by relative path, and read it live', () => {
        for (const html of [light, dark]) {
            assert.ok(html.includes('<link rel="stylesheet" href="dashboard/css/tokens.css">'));
            assert.ok(html.includes('getComputedStyle'));
        }
    });

    it('each forces its own theme and offers the RTL/LTR toggle', () => {
        assert.match(light, /<html lang="ar" dir="rtl" data-theme="light">/);
        assert.match(dark, /<html lang="ar" dir="rtl" data-theme="dark">/);
        for (const html of [light, dark]) assert.ok(html.includes('id="dir-toggle"'));
    });

    it('every colour on the page is a token (the mark too: it paints --mark-tile and --mark-glyph)', () => {
        const css = (/<style>([\s\S]*?)<\/style>/.exec(light)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
        const literals = [...new Set([...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase()))].sort();
        assert.deepEqual(literals, [], 'a hex literal on the preview is a value that will not follow tokens.css');
    });

    it('shows every catalog section', () => {
        for (const id of ['palette', 'contrast', 'type', 'buttons', 'inputs', 'cards', 'chips', 'kw', 'dm', 'platform', 'nav', 'mark']) {
            assert.ok(light.includes(`<section id="${id}">`), `no #${id} section`);
        }
    });
});

// ─── The display face (L3) ─────────────────────────────────────────────────────────────────────────
describe('the display face: Alexandria 600, self-hosted (L3)', () => {
    type Manifest = { spec: { unicodes: string; features: string[]; source: { commit: string } }; output: { file: string; bytes: number; codepoints: number } };
    const manifest = JSON.parse(read('scripts/font/manifest.json')) as Manifest;
    const sec3 = sectionOf(design, 3);
    const styleOf = (html: string): string => (html.match(/<style>[\s\S]*?<\/style>/g) ?? []).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
    const PUBLIC = ['landing', 'pricing', 'privacy', 'terms', 'data-deletion', '404'].map((p) => `public/${p}.html`);
    const sheets: Array<[string, string]> = [
        ...PUBLIC.map((p): [string, string] => [p, styleOf(read(p))]),
        ['dashboard/css/styles.css', read('dashboard/css/styles.css').replace(/\/\*[\s\S]*?\*\//g, '')],
    ];

    it('tokens.css declares --font-display once: the face, its size-adjusted fallback, then the UI stack', () => {
        assert.equal(cssNoComments.match(/--font-display\s*:/g)?.length, 1);
        assert.equal(base['font-display'], "'Alexandria', 'Alexandria Fallback', var(--font-ui)");
    });

    it('DESIGN.md §3 describes the shipped face, with the numbers the build recorded, and no longer calls it planned', () => {
        assert.equal(/planned|not in tokens\.css yet/i.test(sec3), false);
        assert.ok(sec3.includes("`--font-display: 'Alexandria', 'Alexandria Fallback', var(--font-ui)`"));
        assert.ok(sec3.includes(`**${(manifest.output.bytes / 1024).toFixed(1)} KB**`), 'the size is the committed file\'s');
        assert.ok(manifest.output.bytes <= 48 * 1024);
        assert.ok(sec3.includes(manifest.spec.source.commit.slice(0, 7)), 'the pinned source commit');
        assert.ok(sec3.includes(`${manifest.output.codepoints} of those code points`), 'the coverage the build recorded');
        assert.ok(sec3.includes('preloaded on `/` only'));
        assert.ok(sec3.includes('`public/brand/OFL.txt`'));
        assert.ok(sec3.includes('Display is 600 in both scripts'));
    });

    it('the subset DESIGN.md documents is the subset the build uses, and so are its features', () => {
        const subset = /\*\*Subset:\*\*([\s\S]*?)\n {2}- \*\*/.exec(sec3)?.[1] ?? '';
        const documented = [...subset.matchAll(/U\+([0-9A-F]{4})(?:[–-]([0-9A-F]{4}))?/g)].map((m) => `${m[1]}-${m[2] ?? m[1]}`);
        const built = manifest.spec.unicodes.split(',').map((r) => r.replace('U+', '')).map((r) => (r.includes('-') ? r : `${r}-${r}`));
        assert.deepEqual([...documented].sort(), [...built].sort());
        const features = /\*\*OpenType features kept:\*\*\s*([a-zA-Z,\s]+)\(/.exec(sec3)?.[1]?.split(',').map((f) => f.trim()) ?? [];
        assert.ok(features.length >= 15, `parsed ${features.length} features`);
        assert.deepEqual([...features].sort(), manifest.spec.features.filter((f) => f !== 'rvrn').sort(), 'rvrn is the variable font\'s own and resolves away at wght 600');
    });

    it('every public page and styles.css declare the face the same way: Alexandria with `swap`, and a fallback face per script', () => {
        for (const [file, css] of sheets) {
            assert.equal([...css.matchAll(/@font-face\s*\{[^}]*font-family:\s*'Alexandria';[^}]*font-display:\s*swap;[^}]*url\('\/brand\/alexandria-600\.[0-9a-f]{8}\.woff2'\)/g)].length, 1, `${file}: the Alexandria face`);
            assert.equal([...css.matchAll(/@font-face\s*\{[^}]*font-family:\s*'Alexandria Fallback';[^}]*size-adjust:/g)].length, 2, `${file}: the Latin and Arabic fallbacks`);
            assert.ok(css.includes(`url('/brand/${manifest.output.file}')`), `${file} names the font the manifest records`);
        }
    });

    it('uses it for display only: the headings, the wordmark, the figures, the dashboard\'s titles and stat values', () => {
        const USES: Record<string, string[]> = {
            'public/landing.html': ['.figures dt', '.tally dt', '.wordmark', 'h1', 'h2'],
            'public/pricing.html': ['.wordmark', 'h1', 'h2'],
            'public/privacy.html': ['.wordmark', 'h1', 'h2'],
            'public/terms.html': ['.wordmark', 'h1', 'h2'],
            'public/data-deletion.html': ['.wordmark', 'h1', 'h2'],
            'public/404.html': ['.wordmark', 'h1'],
            'dashboard/css/styles.css': ['.login-title', '.page-title', '.sidebar-brand', '.stat-value'],
        };
        for (const [file, css] of sheets) {
            const users = rulesIn(css).filter((r) => /font-family:\s*var\(--font-display\)/.test(r.body)).flatMap((r) => r.selectors);
            assert.deepEqual([...new Set(users)].sort(), USES[file], `${file}: what draws in the display face`);
        }
    });

    it('asks it for weight 600 and nothing else: it is the only weight there is, and 700 would be smeared into a fake bold', () => {
        let seen = 0;
        for (const [file, css] of sheets) {
            for (const r of rulesIn(css)) {
                if (!/font-family:\s*var\(--font-display\)/.test(r.body)) continue;
                const w = /font-weight:\s*([^;]+);/.exec(r.body)?.[1]?.trim();
                assert.ok(w !== undefined && /^(?:600|var\(--fw-semibold(?:, 600)?\)|var\(--lp-fw-display\))$/.test(w), `${file}: ${r.selectors.join(', ')} asks for ${w}`);
                seen++;
            }
        }
        assert.ok(seen >= 20, `${seen} display rules checked`);
    });

    it('no page or stylesheet asks a font CDN for anything', () => {
        for (const [file, css] of sheets) assert.equal(/fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net/.test(css), false, file);
        assert.equal(/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(cssNoComments), false);
    });
});
