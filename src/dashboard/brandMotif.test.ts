/**
 * The identity motif (B2): the keyword highlighter `.kw`, the motion that goes with it, and Rows «سطور».
 *
 * IDENTITY.md sections 3 and 6 specify them; DESIGN.md sections 2, 4 and 6 document them; dashboard/css/tokens.css is where
 * they are defined (the public pages load tokens.css and not styles.css, and the landing is on a served-bytes budget). This
 * file pins what a screenshot cannot: that the tokens and classes exist and say what the spec says, that the one thing that
 * moves is `transform` or `opacity`, that reduced motion switches all of it off (and that this test notices if it does not),
 * that Rows is the pattern the spec draws, that the landing's headline, the closing band and the login use it, that
 * `Motion.highlightDeliver` runs the sequence it promises, and that the landing is still inside its budget.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { DEFAULT_CONTACT_EMAIL, type SiteSettings } from '../services/appSettings.js';
import { compactPublicPage, renderSiteTemplate } from '../services/publicPages.js';

const read = (p: string): string => readFileSync(p, 'utf8');
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

const TOKENS_CSS = read('dashboard/css/tokens.css');
const CSS = stripComments(TOKENS_CSS);
const LANDING = read('public/landing.html');
const INDEX = read('dashboard/index.html');

/** The body of the first block that follows `head` (a selector or an at-rule prelude), with its braces balanced. */
function blockAfter(css: string, head: string, from = 0): { body: string; start: number; end: number } | null {
    const at = css.indexOf(head, from);
    if (at < 0) return null;
    const open = head.endsWith('{') ? at + head.length - 1 : css.indexOf('{', at + head.length);
    let depth = 1;
    let i = open + 1;
    while (i < css.length && depth > 0) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') depth--;
        i++;
    }
    return { body: css.slice(open + 1, i - 1), start: at, end: i };
}

/** What the reduced-motion guard must say, as problems (empty is a pass). Run on the real stylesheet and on a mutated copy. */
function reducedMotionProblems(css: string): string[] {
    const problems: string[] = [];
    // The motif's guard is the last reduced-motion block in the file (tokens.css has an older one for --motion-*, above it).
    const guard = blockAfter(css, '@media (prefers-reduced-motion: reduce)', css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    if (!guard) return ['no @media (prefers-reduced-motion: reduce) block'];
    for (const t of ['kw-sweep', 'kw-hold', 'kw-deliver', 'kw-receipt']) {
        if (!new RegExp(`--${t}:\\s*1ms;`).test(guard.body)) problems.push(`--${t} is not 1ms under reduced motion`);
    }
    if (!/\.is-sweeping::before,\s*\.is-receipt::after\s*\{\s*animation:\s*none;\s*\}/.test(guard.body)) problems.push('the sweep and the receipt still animate under reduced motion');
    if (!/\.kw-packet\s*\{\s*display:\s*none;\s*\}/.test(guard.body)) problems.push('the packet is still drawn under reduced motion');
    // It must come after the rules it overrides, or an equal-specificity rule below it wins.
    const lastAnimating = Math.max(css.lastIndexOf('\n.is-sweeping::before {'), css.lastIndexOf('\n.is-receipt::after {'), css.lastIndexOf('\n.kw-packet {'));
    if (lastAnimating < 0 || guard.start < lastAnimating) problems.push('the guard comes before a rule it has to outrank');
    return problems;
}

describe('B2: the tokens', () => {
    it('--kw-* are the four durations of IDENTITY.md section 6, 960ms in all', () => {
        const values = Object.fromEntries(['sweep', 'hold', 'deliver', 'receipt'].map((n) => [n, new RegExp(`--kw-${n}:\\s*(\\d+)ms;`).exec(CSS)?.[1]]));
        assert.deepEqual(values, { sweep: '320', hold: '120', deliver: '320', receipt: '200' });
        assert.equal(Object.values(values).reduce((sum, v) => sum + Number(v), 0), 960, 'sweep + hold + deliver + receipt');
    });

    it('--pattern-ink is declared in the dark block and in both light blocks, as IDENTITY.md section 3 gives it', () => {
        const dark = /:root,\s*:root\[data-theme='dark'\]\s*\{[\s\S]*?--pattern-ink:\s*(rgba\([^)]*\));/.exec(CSS)?.[1];
        assert.equal(dark, 'rgba(255, 255, 255, 0.06)');
        const light = [...CSS.matchAll(/--pattern-ink:\s*(rgba\([^)]*\));/g)].map((m) => m[1]);
        assert.deepEqual(light, ['rgba(255, 255, 255, 0.06)', 'rgba(24, 26, 16, 0.06)', 'rgba(24, 26, 16, 0.06)'], 'dark, light (OS-asked), light (pinned): each exactly once');
    });
});

describe('B2: the classes', () => {
    it('.kw is DESIGN.md section 4: the highlighter, its ring, the accent label, radius 8, .1em .3em, semibold', () => {
        const kw = blockAfter(CSS, '\n.kw {')!.body;
        assert.match(kw, /background:\s*var\(--accent-soft\);/);
        assert.match(kw, /box-shadow:\s*inset 0 0 0 1px var\(--accent-ring\);/);
        assert.match(kw, /color:\s*var\(--accent-text\);/);
        assert.match(kw, /border-radius:\s*var\(--radius-sm\);/);
        assert.match(kw, /padding:\s*0\.1em 0\.3em;/);
        assert.match(kw, /font-weight:\s*var\(--fw-semibold\);/);
    });

    it('.kw-display is the headline variant: radius .18em, padding .02em .16em, margin-inline -.1em, a 1px ring', () => {
        const display = blockAfter(CSS, '\n.kw-display {')!.body;
        assert.match(display, /border-radius:\s*0\.18em;/);
        assert.match(display, /padding:\s*0\.02em 0\.16em;/);
        assert.match(display, /margin-inline:\s*-0\.1em;/);
        // The ring is drawn by the ::before the sweep scales, with the same 1px inset ring `.kw` has.
        const before = blockAfter(CSS, ':is(.kw-display, .kw.is-sweeping)::before {')!.body;
        assert.match(before, /box-shadow:\s*inset 0 0 0 1px var\(--accent-ring\);/);
        assert.match(before, /background:\s*var\(--accent-soft\);/);
        assert.match(before, /transform-origin:\s*0 50%;/);
        assert.ok(CSS.includes(':is(.kw-display, .kw.is-sweeping):dir(rtl)::before { transform-origin: 100% 50%; }'), 'the sweep starts at the inline-start, in RTL too');
    });

    it('the sweep, the packet and the receipt run on the --kw-* tokens', () => {
        assert.match(CSS, /\.is-sweeping::before \{ animation: kw-sweep var\(--kw-sweep\) var\(--ease-standard\) both; \}/);
        assert.match(blockAfter(CSS, '.is-receipt::after {')!.body, /animation:\s*kw-receipt var\(--kw-receipt\) var\(--ease-exit\) 1;/);
        const packet = blockAfter(CSS, '\n.kw-packet {')!.body;
        assert.match(packet, /animation:\s*kw-fly var\(--kw-deliver\) var\(--ease-standard\) both,\s*kw-fade var\(--kw-deliver\) linear both;/);
        assert.match(packet, /inline-size:\s*6px;/);
        assert.match(packet, /block-size:\s*6px;/);
        assert.match(CSS, /@keyframes kw-fade \{ 75% \{ opacity: 1; \} to \{ opacity: 0; \} \}/, 'the packet fades over its last 25%');
    });

    it('`.is-receipt` is a ring on ::after whose opacity runs 0 -> 1 -> 0 once, and anchors at zero specificity', () => {
        const after = blockAfter(CSS, '.is-receipt::after {')!.body;
        assert.match(after, /box-shadow:\s*0 0 0 var\(--ring\) var\(--accent-ring\);/);
        assert.match(after, /opacity:\s*0;/);
        assert.match(CSS, /@keyframes kw-receipt \{ 0%, 100% \{ opacity: 0; \} 40% \{ opacity: 1; \} \}/);
        assert.ok(CSS.includes(':where(.is-receipt) { position: relative; }'));
    });

    it('everything that moves is `transform` or `opacity`: no other property is keyframed, and nothing here is `transition: all`', () => {
        const names = [...CSS.matchAll(/@keyframes (kw-[a-z]+)/g)].map((m) => m[1]);
        assert.deepEqual(names.sort(), ['kw-fade', 'kw-fly', 'kw-receipt', 'kw-sweep']);
        for (const name of names) {
            const body = blockAfter(CSS, `@keyframes ${name}`)!.body;
            const props = new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]));
            for (const p of props) assert.ok(p === 'transform' || p === 'opacity', `@keyframes ${name} moves ${p}`);
        }
        const identity = CSS.slice(CSS.indexOf('\n.kw {'));
        assert.equal(/transition\s*:/.test(identity), false, 'the motif declares no transition');
    });
});

describe('B2: reduced motion', () => {
    it('every step is 1ms, the CSS animations are off and no packet is drawn', () => {
        assert.deepEqual(reducedMotionProblems(CSS), []);
    });

    it('mutation: with the guard taken out, this test notices (and the mutation really was applied)', () => {
        const guard = blockAfter(CSS, '@media (prefers-reduced-motion: reduce)', CSS.lastIndexOf('@media (prefers-reduced-motion: reduce)'))!;
        const mutated = CSS.slice(0, guard.start) + CSS.slice(guard.end);
        assert.notEqual(mutated, CSS, 'the anchor was found and removed');
        assert.equal(mutated.includes('.kw-packet { display: none; }'), false, 'the guard is gone from the copy');
        assert.notDeepEqual(reducedMotionProblems(mutated), []);
        // And a guard that is present but ahead of the rules it overrides is not a guard either.
        const early = blockAfter(CSS, '\n.is-sweeping::before {')!;
        const moved = CSS.slice(0, early.start) + CSS.slice(guard.start, guard.end) + '\n' + CSS.slice(early.start, guard.start) + CSS.slice(guard.end);
        assert.notEqual(moved, CSS);
        assert.deepEqual(reducedMotionProblems(moved), ['the guard comes before a rule it has to outrank']);
    });

    it('the landing starts its closing-band sweep only where it already refuses to animate under reduced motion', () => {
        const calm = LANDING.indexOf("var calm = !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: no-preference)').matches;");
        const bail = LANDING.indexOf("if (!calm || !('IntersectionObserver' in window)) return;");
        const sweep = LANDING.indexOf("if (el.className === 'cta') el.querySelector('.kw').classList.add('is-sweeping');");
        assert.ok(calm > 0 && bail > calm && sweep > bail, 'the sweep is after the early return');
        // The band's class list is exactly "cta" only until .is-inview is added, and the check reads it: so the sweep comes first.
        assert.ok(sweep < LANDING.indexOf("el.classList.add('is-inview');", sweep - 200), 'the sweep is asked before .is-inview changes the class list');
    });
});

describe('B2: Rows «سطور» (#rows)', () => {
    const defs = (html: string): string => /<svg id="rows-ink"[\s\S]*?<\/svg>/.exec(html)![0];

    it('the pattern is the same bytes in the dashboard and the landing, defined once per page', () => {
        assert.equal(defs(INDEX), defs(LANDING));
        assert.equal((INDEX.match(/<svg id="rows-ink"/g) ?? []).length, 1);
        assert.equal((LANDING.match(/<svg id="rows-ink"/g) ?? []).length, 1);
        assert.equal((INDEX.match(/<pattern id="rows"/g) ?? []).length, 1);
    });

    it('it is a 576x192 tile inked by --pattern-ink through currentColor, with no colour literal', () => {
        const svg = defs(LANDING);
        assert.match(svg, /<svg id="rows-ink" width="0" height="0" style="position:absolute;color:var\(--pattern-ink\)" aria-hidden="true" focusable="false">/);
        assert.match(svg, /<pattern id="rows" width="576" height="192" patternUnits="userSpaceOnUse">/);
        assert.match(svg, /stroke="currentColor" stroke-width="8" stroke-linecap="round"/);
        assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(svg), false);
    });

    it('it draws 8 rows every 24px of 8px pills with 8px gaps, from {16,24,32,48,64}, ragged, every third row a short reply at 32px', () => {
        const d = /<path d="([^"]+)"/.exec(defs(LANDING))![1]!;
        // `M x y` starts a row at its first pill's centre line, `h n` is a pill of n + 8 (the round caps), `m 16 0` is the gap.
        const rows = new Map<number, Array<{ left: number; len: number }>>();
        let x = 0;
        let y = 0;
        for (const m of d.matchAll(/([Mmh])(-?\d+(?: -?\d+)?)/g)) {
            const [a, b] = m[2]!.split(' ').map(Number) as [number, number];
            if (m[1] === 'M') { x = a; y = b; } else if (m[1] === 'm') { x += a; y += b; } else {
                const row = (y - 12) / 24;
                assert.ok(Number.isInteger(row) && row >= 0 && row < 8, `a pill on y=${y}`);
                rows.set(row, [...(rows.get(row) ?? []), { left: x - 4, len: a + 8 }]);
                x += a;
            }
        }
        assert.deepEqual([...rows.keys()].sort((p, q) => p - q), [0, 1, 2, 3, 4, 5, 6, 7], 'eight rows');
        const ends: number[] = [];
        for (const [row, pills] of rows) {
            assert.equal(pills[0]!.left, row % 3 === 2 ? 32 : 0, `row ${row + 1} starts at the inline-start${row % 3 === 2 ? ', indented 32' : ''}`);
            pills.forEach((p, i) => {
                assert.ok([16, 24, 32, 48, 64].includes(p.len), `row ${row + 1}: a pill of ${p.len}`);
                if (i > 0) assert.equal(p.left, pills[i - 1]!.left + pills[i - 1]!.len + 8, `row ${row + 1}: an 8px gap`);
            });
            const last = pills[pills.length - 1]!;
            ends.push(last.left + last.len);
            assert.ok(last.left + last.len <= 576 - 96, `row ${row + 1} leaves a gutter before the tile repeats`);
        }
        assert.ok(new Set(ends).size >= 6, `ragged: ${ends}`);
        assert.ok(Math.max(ends[2]!, ends[5]!) < Math.min(...ends.filter((_, i) => i % 3 !== 2)), 'the replies are shorter than the rows they answer');
    });

    it('every .rows svg paints #rows and carries exactly one lit bar, in the reading-end third', () => {
        for (const html of [INDEX, LANDING]) {
            const all = [...html.matchAll(/<svg class="rows"[^>]*>([\s\S]*?)<\/svg>/g)];
            assert.ok(all.length >= 1);
            for (const m of all) {
                assert.match(m[1]!, /<rect width="100%" height="100%" fill="url\(#rows\)"\/>/);
                const lit = [...m[1]!.matchAll(/<rect class="lit" x="(\d+)%" y="([^"]+)" width="63" height="7" rx="3.5"\/>/g)];
                assert.equal(lit.length, 1, 'one lit bar per composition');
                assert.ok(Number(lit[0]![1]) >= 67, 'in the reading-end third (the svg is mirrored in RTL, lit bar included)');
            }
            assert.match(/<svg class="rows"[^>]*>/.exec(html)![0], /aria-hidden="true"/, 'decoration, not content');
        }
    });

    it('the classes: the field is mirrored in RTL, masked in from the reading end, and the lit bar is the highlighter', () => {
        assert.ok(CSS.includes("[dir='rtl'] .rows { transform: scaleX(-1); }"));
        const rows = blockAfter(CSS, '\n.rows {')!.body;
        assert.match(rows, /position:\s*absolute;/);
        assert.match(rows, /pointer-events:\s*none;/);
        assert.match(rows, /mask-image:\s*linear-gradient\(to right, transparent 30%, currentColor 70%\);/);
        const lit = blockAfter(CSS, '.rows .lit {')!.body;
        assert.match(lit, /fill:\s*var\(--accent-soft\);/);
        assert.match(lit, /stroke:\s*var\(--accent-ring\);/);
        assert.match(lit, /stroke-width:\s*1px;/);
    });
});

describe('B2: where it is used', () => {
    it('the landing headline lights one word, in both languages, and the words are unchanged', () => {
        const ar = /<h1 id="hero-ar">([\s\S]*?)<\/h1>/.exec(LANDING)![1]!;
        const en = /<h1 id="hero-en">([\s\S]*?)<\/h1>/.exec(LANDING)![1]!;
        assert.equal(ar, 'فيديوهاتك تصير منشورات، وتعليقاتهم تصير <span class="kw kw-display is-sweeping">محادثات</span>');
        assert.equal(en, 'Your videos become posts. Their comments become <span class="kw kw-display is-sweeping">conversations</span>.');
        for (const h1 of [ar, en]) assert.equal((h1.match(/class="kw /g) ?? []).length, 1, 'one .kw per headline');
    });

    it('the closing band lights one word of its headline and paints Rows behind its text, in both languages', () => {
        for (const [id, lit] of [['cta-ar', 'تعليق'], ['cta-en', 'comment']] as const) {
            const band = LANDING.slice(LANDING.lastIndexOf('<div class="cta">', LANDING.indexOf(`id="${id}"`)), LANDING.indexOf('</section>', LANDING.indexOf(`id="${id}"`)));
            assert.match(band, /^<div class="cta">\s*<svg class="rows" aria-hidden="true">/, `${id}: Rows is the band's first child`);
            assert.ok(band.includes(`<span class="kw kw-display">${lit}</span>`), `${id}: ${lit} is lit`);
            assert.equal((band.match(/class="kw /g) ?? []).length, 1, `${id}: one .kw`);
            assert.equal((band.match(/class="lit"/g) ?? []).length, 1, `${id}: one lit bar`);
        }
        assert.match(stripComments(LANDING), /\.cta \.rows \{ z-index: -1; \}/, 'under the band text, above its glass');
        assert.equal(/(^|\n)\s*\.kw\s*\{/.test(stripComments(LANDING.slice(LANDING.indexOf('<style'), LANDING.indexOf('</style>')))), false, 'the landing no longer carries its own .kw: tokens.css is the one definition');
    });

    it('the login lights one word of its subtitle through data-i18n-kw, in both languages, and paints Rows instead of the glow', () => {
        const login = /<div id="login-screen"[\s\S]*?<!-- ─── Invite/.exec(INDEX)![0];
        assert.match(login, /<svg class="rows" aria-hidden="true">/);
        assert.equal(login.includes('login-glow'), false, 'Rows replaces the glow on the login');
        assert.equal((INDEX.match(/login-glow/g) ?? []).length, 2, 'the invite and welcome screens keep theirs');
        assert.match(login, /<p class="login-subtitle" data-i18n="login\.subtitle" data-i18n-kw="login\.subtitleKw">[^<]*<span class="kw">[^<]+<\/span>[^<]*<\/p>/);
        assert.equal(/class="login-title"[^>]*>[^<]*<span class="kw/.test(login), false, 'never on the brand name');
        for (const [file, lang] of [['dashboard/js/i18n.ar.js', 'ar'], ['dashboard/js/i18n.en.js', 'en']] as const) {
            const dict = read(file);
            const word = /'login\.subtitleKw': '([^']+)'/.exec(dict)?.[1];
            const subtitle = /'login\.subtitle': '([^']+)'/.exec(dict)?.[1];
            assert.ok(word && subtitle, lang);
            assert.equal(subtitle!.split(word!).length, 2, `${lang}: "${word}" is in "${subtitle}" exactly once`);
            assert.equal(word!.includes(' '), false, `${lang}: one word`);
        }
    });

    it('a data-i18n-kw word is wrapped in .kw inside the translated text, and a word that is not there lights nothing', () => {
        const ctx = vm.createContext({ console, Intl, navigator: { language: 'ar' }, localStorage: undefined, document: { documentElement: {} } }) as Record<string, unknown>;
        for (const f of ['dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js']) vm.runInContext(read(f), ctx, { filename: f });
        const { I18N } = vm.runInContext('({ I18N })', ctx) as { I18N: { lang: string; applyStatic(root: unknown): void } };
        const span = (): { className: string; textContent: string } => ({ className: '', textContent: '' });
        const el = (key: string, kwKey: string) => {
            const node = {
                textContent: '',
                parts: [] as unknown[],
                getAttribute: (n: string) => (n === 'data-i18n' ? key : n === 'data-i18n-kw' ? kwKey : null),
                append(...p: unknown[]) { this.parts = p; },
            };
            return node;
        };
        const doc = (nodes: ReturnType<typeof el>[]) => ({
            querySelectorAll: (sel: string) => (sel === '[data-i18n]' || sel === '[data-i18n-kw]' ? nodes : []),
        });
        (ctx.document as Record<string, unknown>).createElement = span;

        I18N.lang = 'ar';
        const lit = el('login.subtitle', 'login.subtitleKw');
        I18N.applyStatic(doc([lit]));
        const [before, kw, after] = lit.parts as [string, { className: string; textContent: string }, string];
        assert.equal(kw.className, 'kw');
        assert.equal(`${before}${kw.textContent}${after}`, 'استوديو نموّ لصنّاع المحتوى العرب', 'the sentence is intact');
        assert.equal(kw.textContent, 'نموّ');

        I18N.lang = 'en';
        const en = el('login.subtitle', 'login.subtitleKw');
        I18N.applyStatic(doc([en]));
        assert.equal((en.parts[1] as { textContent: string }).textContent, 'growth');

        const none = el('login.subtitle', 'login.email');   // a key whose word is not in the sentence
        I18N.applyStatic(doc([none]));
        assert.equal(none.parts.length, 0, 'nothing is wrapped');
        assert.equal(none.textContent, 'A growth studio for Arabic creators');
    });
});

describe('B2: Motion.highlightDeliver', () => {
    interface Fake {
        classes: Set<string>;
        listeners: Map<string, Array<() => void>>;
        style: { cssText: string };
        isConnected: boolean;
        className: string;
        offsetWidth: number;
        rect: { left: number; top: number; width: number; height: number };
        classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
        getBoundingClientRect(): Fake['rect'];
        setAttribute(n: string, v: string): void;
        addEventListener(type: string, fn: () => void): void;
        remove(): void;
        fire(type: string): void;
    }
    const fake = (rect = { left: 0, top: 0, width: 10, height: 10 }): Fake => {
        const f: Fake = {
            classes: new Set(), listeners: new Map(), style: { cssText: '' }, isConnected: true, className: '', offsetWidth: 0, rect,
            classList: { add: (c) => { f.classes.add(c); }, remove: (c) => { f.classes.delete(c); }, contains: (c) => f.classes.has(c) },
            getBoundingClientRect: () => f.rect,
            setAttribute: () => {},
            addEventListener: (type, fn) => { f.listeners.set(type, [...(f.listeners.get(type) ?? []), fn]); },
            remove: () => { f.isConnected = false; },
            fire: (type) => { for (const fn of f.listeners.get(type) ?? []) fn(); f.listeners.delete(type); },
        };
        return f;
    };

    function load(reduced: boolean, tokens: Record<string, string> = { '--kw-sweep': '4ms', '--kw-hold': '2ms', '--kw-deliver': '4ms', '--kw-receipt': '3ms' }) {
        const appended: Fake[] = [];
        const ctx = vm.createContext({
            console, setTimeout, clearTimeout,
            document: {
                documentElement: {},
                body: { appendChild: (p: Fake) => { appended.push(p); } },
                createElement: () => fake(),
            },
            window: { matchMedia: () => ({ matches: reduced }) },
            getComputedStyle: () => ({ getPropertyValue: (n: string) => tokens[n] ?? '' }),
        });
        vm.runInContext(read('dashboard/js/motion.js'), ctx, { filename: 'dashboard/js/motion.js' });
        const { Motion } = vm.runInContext('({ Motion })', ctx) as { Motion: { highlightDeliver(a: unknown, b: unknown): Promise<boolean>; _kwMs(n: string): number } };
        return { Motion, appended };
    }
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    it('reads the --kw-* tokens in milliseconds, and treats what it cannot read as 1ms', () => {
        const { Motion } = load(false, { '--kw-sweep': '320ms', '--kw-hold': '0.12s', '--kw-deliver': '', '--kw-receipt': 'junk' });
        assert.equal(Motion._kwMs('--kw-sweep'), 320);
        assert.equal(Motion._kwMs('--kw-hold'), 120);
        assert.equal(Motion._kwMs('--kw-deliver'), 1);
        assert.equal(Motion._kwMs('--kw-receipt'), 1);
        assert.equal(Motion._kwMs('--kw-missing'), 1);
    });

    it('sweeps, holds, flies a packet from the keyword to the target, then shows the receipt once', async () => {
        const { Motion, appended } = load(false);
        const src = fake({ left: 10, top: 20, width: 40, height: 10 });
        const target = fake({ left: 100, top: 200, width: 80, height: 40 });
        const done = Motion.highlightDeliver(src, target);
        assert.ok(src.classes.has('is-sweeping'), 'the highlight sweeps first');
        assert.equal(appended.length, 0, 'no packet during the sweep and the hold');
        await sleep(25);
        assert.equal(appended.length, 1, 'the packet is drawn after the hold');
        const packet = appended[0]!;
        assert.equal(packet.className, 'kw-packet');
        assert.equal(packet.style.cssText, '--x0:30;--y0:25;--x1:140;--y1:220', "centre to centre, in viewport pixels");
        assert.equal(target.classes.has('is-receipt'), false, 'the ring waits for the packet to land');
        packet.fire('animationend');
        assert.equal(packet.isConnected, false, 'the packet is removed on landing');
        assert.ok(target.classes.has('is-receipt'), 'the target shows its ring');
        assert.equal(await done, true);
        assert.equal(target.classes.has('is-receipt'), false, 'and it is taken off again once shown');
    });

    it('still delivers when the animation never ends (a hidden tab), and never twice', async () => {
        const { Motion, appended } = load(false);
        const src = fake();
        const target = fake();
        let shown = 0;
        const add = target.classList.add;
        target.classList.add = (c) => { if (c === 'is-receipt') shown++; add(c); };
        const done = Motion.highlightDeliver(src, target);
        await sleep(25);
        const packet = appended[0]!;
        assert.equal(await done, true, 'the timer lands it');
        packet.fire('animationend');
        await sleep(15);
        assert.equal(shown, 1, 'one receipt');
    });

    it('under reduced motion draws no packet: the steps still run, each 1ms', async () => {
        const { Motion, appended } = load(true, { '--kw-sweep': '1ms', '--kw-hold': '1ms', '--kw-deliver': '1ms', '--kw-receipt': '1ms' });
        const src = fake();
        const target = fake();
        const started = Date.now();
        assert.equal(await Motion.highlightDeliver(src, target), true);
        assert.ok(Date.now() - started < 100);
        assert.equal(appended.length, 0);
        assert.ok(src.classes.has('is-sweeping'));
    });

    it('does nothing, and says so, when either end is no longer on the page', async () => {
        const { Motion, appended } = load(false);
        const gone = fake();
        gone.isConnected = false;
        const here = fake();
        assert.equal(await Motion.highlightDeliver(gone, here), false);
        assert.equal(await Motion.highlightDeliver(here, null), false);
        assert.equal(here.classes.size, 0);
        // And one that leaves during the sweep.
        const src = fake();
        const target = fake();
        const pending = Motion.highlightDeliver(src, target);
        target.isConnected = false;
        assert.equal(await pending, false);
        assert.equal(appended.length, 0);
    });
});

describe('B2: the landing stays inside its served-bytes budget (L6)', () => {
    // 215 KB until 2026-10-19, when the platform strip (five marks, names and lines, in both languages, and its CSS) took the landing from
    // 211.7 KB to 215.8 KB served and the owner asked for it: the budget is 220 KB, with the same 3 KB left for copy. Raise it only for a
    // feature somebody asked for, in the commit that adds the feature.
    const BUDGET = 220 * 1000;
    const served = (lang: 'ar' | 'en', site: SiteSettings): number =>
        Buffer.byteLength(renderSiteTemplate(compactPublicPage(LANDING), site, lang, 'https://example.test'));

    it('is at most 220 KB with 3 KB to spare, in both languages with every setting on and off', () => {
        const all: SiteSettings = { whatsappNumber: '966501234567', contactEmail: 'hello@example.com', eidCouponsExpire: '2026-04-05' };
        const bare: SiteSettings = { whatsappNumber: null, contactEmail: DEFAULT_CONTACT_EMAIL, eidCouponsExpire: null };
        const worst = Math.max(...(['ar', 'en'] as const).flatMap((lang) => [served(lang, all), served(lang, bare)]));
        assert.ok(worst <= BUDGET - 3000, `${worst} bytes served`);
    });

    it('carries the motif once: one pattern, two lit-bar bands, one definition of .kw (in tokens.css, not here)', () => {
        assert.equal((LANDING.match(/<pattern id="rows"/g) ?? []).length, 1);
        assert.equal((LANDING.match(/<svg class="rows"/g) ?? []).length, 2);
        assert.equal(/@keyframes kw-/.test(LANDING), false);
    });
});
