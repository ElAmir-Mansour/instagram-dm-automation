/**
 * DESIGN.md and tokens.css must say the same thing, and the logo must not move.
 *
 * DESIGN.md §2 is a copy of dashboard/css/tokens.css, written so that a person can read it. A copy
 * with nothing checking it is a second palette that drifts: the previous DESIGN.md still said
 * `--accent` was Apple's blue two palettes after it stopped being. So every row of §2's tables is
 * parsed here and compared with the value tokens.css actually resolves to in that theme, and every
 * colour token in tokens.css must have a row. Edit one without the other and this fails.
 *
 * The second job is the logo. The app is in TikTok's review with the current mark (Lucide's zap on
 * a #0071e3 tile), so the palette swap must not be able to recolour it: the mark paints three pinned
 * tokens, the favicon is a pinned file, and the manifest's icon list is pinned. When TikTok accepts
 * the app and the ر mark replaces this one, the constants below are edited on purpose, in that PR.
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

    it('is no longer a draft, and says the logo is frozen and the ر mark is next', () => {
        assert.equal(/\bDRAFT\b/.test(design), false);
        assert.ok(design.includes('FROZEN'));
        assert.ok(design.includes('after TikTok accepts the app'));
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

// ─── The logo is frozen ────────────────────────────────────────────────────────────────────────
//
// Constants, not reads: the point is that changing any of them is a deliberate edit of this file.
const FROZEN = {
    markTile: '#0071e3',
    markTileLit: 'linear-gradient(180deg, #0a7cf0, var(--mark-tile) 60%, #0064cc)',
    /** What that gradient resolves to: the one main drew on the tile before the palette changed. */
    markTileLitResolved: 'linear-gradient(180deg, #0a7cf0, #0071e3 60%, #0064cc)',
    markGlyph: '#ffffff',
    /** sha256 of public/favicon.svg as it stood on main before the Ink & Cardamom palette. */
    faviconSha256: 'a02eb3d94c25766bcbca5fdc76b7ba9fc8b0a9b7f49be7c5537859949eabf49f',
};

describe('the logo mark is frozen until TikTok accepts the app', () => {
    it('the three mark tokens hold their pinned values, in the theme-independent block only', () => {
        assert.equal(base['mark-tile'], FROZEN.markTile);
        assert.equal(base['mark-tile-lit'], FROZEN.markTileLit);
        assert.equal((base['mark-tile-lit'] as string).replace('var(--mark-tile)', base['mark-tile'] as string), FROZEN.markTileLitResolved);
        assert.equal(base['mark-glyph'], FROZEN.markGlyph);
        for (const [name, block] of Object.entries({ dark: darkBlock, 'light (media)': lightMedia, 'light (pinned)': lightPinned })) {
            for (const t of ['mark-tile', 'mark-tile-lit', 'mark-glyph']) {
                assert.equal(block[t], undefined, `--${t} is overridden in the ${name} block: the mark must be the same in both themes`);
            }
        }
    });

    it('.logo-mark and .login-mark paint the mark tokens, and no rule anywhere paints them from the accent', () => {
        const css = read('dashboard/css/styles.css').replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
        const rules = rulesIn(css);

        // 1. The base rules say what the mark is made of.
        for (const sel of ['.logo-mark', '.login-mark']) {
            const base = rules.filter((r) => r.selectors.includes(sel));
            assert.ok(base.length >= 1, `${sel} has no rule`);
            const tile = base.find((r) => /(^|[;\s])background:\s*var\(--mark-tile-lit\)/.test(r.body));
            assert.ok(tile, `${sel}: no rule paints its background from --mark-tile-lit, as one layer`);
            assert.doesNotMatch(tile.body, /background-color:/, `${sel}: a background-color under the gradient shifts the mark's edge pixels`);
            const glyph = rules.filter((r) => r.selectors.includes(`${sel} svg`));
            assert.ok(glyph.some((r) => /(^|[;\s])color:\s*var\(--mark-glyph\)/.test(r.body)), `${sel} svg: no rule paints the glyph from --mark-glyph`);
        }

        // 2. EVERY rule that can reach the mark, in any block (a @media rule, a later override, a parent
        //    selector), is free of the accent family. The first-match version of this test passed a
        //    `@media { .logo-mark { background: var(--gradient-brand) } }` appended further down the file.
        const REACHES_THE_MARK = /logo-mark|login-mark|sidebar-logo|login-logo/;
        const ACCENT_FAMILY = /var\(--(?:accent[a-z-]*|gradient-brand[a-z-]*|text-on-accent|chart-accent)\)/;
        const touching = rules.filter((r) => r.selectors.some((x) => REACHES_THE_MARK.test(x)));
        assert.ok(touching.length >= 6, `only ${touching.length} rules reach the mark; the scan is not reading the stylesheet`);
        const offenders = touching.filter((r) => ACCENT_FAMILY.test(r.body)).map((r) => `${r.selectors.join(', ')} { ${r.body.trim()} }`);
        assert.deepEqual(offenders, [], 'a rule paints the frozen mark from the accent');
        // ...and none of them re-colours it by a literal either.
        const literal = touching.filter((r) => /(?:background|color|fill|stroke)[a-z-]*:[^;]*(?:#[0-9a-fA-F]{3,8}\b|rgba?\()/.test(r.body)).map((r) => r.selectors.join(', '));
        assert.deepEqual(literal, [], 'a rule paints the frozen mark from a colour literal instead of the mark tokens');
    });

    it('the markup is still Lucide\'s zap in both places', () => {
        const html = read('dashboard/index.html');
        assert.ok(html.includes('<div class="login-mark"><i data-lucide="zap" aria-hidden="true"></i></div>'));
        assert.ok(html.includes('<div class="logo-mark"><i data-lucide="zap" aria-hidden="true"></i></div>'));
    });

    it('public/favicon.svg is byte-identical to the one the app was submitted with', () => {
        const svg = readFileSync('public/favicon.svg');
        assert.equal(createHash('sha256').update(svg).digest('hex'), FROZEN.faviconSha256);
        assert.match(svg.toString('utf8'), /<rect width="64" height="64" rx="14" fill="#0071e3"\/>/);
    });

    it('the manifest still lists exactly the favicon as its icon', () => {
        const manifest = JSON.parse(read('public/site.webmanifest')) as { icons: unknown };
        assert.deepEqual(manifest.icons, [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }]);
    });

    it('#0071e3 lives only in the four places that are the logo', () => {
        const hits: string[] = [];
        const walk = (dir: string): void => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const p = `${dir}/${e.name}`;
                if (e.isDirectory()) {
                    if (e.name === 'samples') continue;
                    walk(p);
                } else if (/\.(css|js|html|svg|webmanifest|ts|mjs)$/.test(e.name) && /#0071e3/i.test(read(p))) {
                    hits.push(p);
                }
            }
        };
        for (const d of ['dashboard', 'public', 'src', 'scripts']) walk(d);
        const allowed = [
            'dashboard/css/tokens.css', // the pinned mark tokens
            'public/favicon.svg', // the favicon
            'public/site.webmanifest', // theme_color: browser chrome, moves with the logo
            'src/dashboard/design-md.test.ts', // this file
        ];
        assert.deepEqual(hits.sort(), allowed.sort(), 'the old blue is back somewhere that is not the logo, or the logo lost one of its places');
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
        assert.equal((charts.match(/opts\.token \|\| '--chart-accent'/g) ?? []).length, 2, 'the sparkline and the line chart');
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

    it('every colour on the page is a token, except the planned ر mark\'s two', () => {
        const css = (/<style>([\s\S]*?)<\/style>/.exec(light)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
        const literals = [...new Set([...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase()))].sort();
        assert.deepEqual(literals, ['#1a1c15', '#bcde70'], 'a hex literal on the preview is a value that will not follow tokens.css');
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
