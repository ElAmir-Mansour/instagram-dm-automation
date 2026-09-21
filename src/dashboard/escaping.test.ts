/**
 * The dashboard's XSS defence.
 *
 * This is the code that closed a complete unauthenticated path to account takeover: a
 * stranger set their Facebook display name to a payload, commented a campaign keyword, and
 * the name was copied verbatim into `interactions.sender_username` and then injected into
 * the dashboard as both element content and an `href` — where it could read the session
 * token out of `localStorage`, and that token was the only thing gating the Meta Page token.
 *
 * `esc()`, `html` and `safeUrl()` are the whole of that defence, and until now the entire
 * `dashboard/` tree had **no tests at all** — 26 server test files, zero for the browser
 * code. A regression in `esc()` would reopen the whole class silently: escaped or not, the
 * page renders.
 *
 * ── Why this lives under `src/` ──
 * `npm test` globs `src/**\/*.test.ts`. The dashboard has no build step and no module
 * system — `components.js` is a plain script that defines globals — so it is loaded here in
 * a `node:vm` context with the few browser globals it touches at load time stubbed out.
 * That means these tests exercise the **real shipped file**, not a copy, and cannot drift
 * from it. If `components.js` starts needing another global at load, this fails loudly
 * rather than testing a stale duplicate.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

interface Loaded {
    html: (strings: TemplateStringsArray, ...values: unknown[]) => { toString(): string };
    esc: (value: unknown) => string;
    safeUrl: (value: unknown) => string;
    SafeHtml: new (value: string) => object;
}

/** Load the real dashboard script in a sandbox and hand back its escaping primitives. */
function loadComponents(): Loaded {
    const src = readFileSync('dashboard/js/components.js', 'utf8');
    const noop = (): void => {};
    const stubEl = {
        addEventListener: noop, removeEventListener: noop,
        querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null,
        contains: () => false, children: [],
    };
    const ctx: Record<string, unknown> = {
        document: {
            ...stubEl,
            createElement: () => ({ ...stubEl }),
            body: { ...stubEl }, head: { ...stubEl },
            documentElement: { ...stubEl, lang: 'ar', dir: 'rtl' },
            getElementById: () => null, activeElement: null,
        },
        window: {
            addEventListener: noop,
            matchMedia: () => ({ matches: false, addEventListener: noop }),
            location: { hash: '' },
        },
        Intl, console, setTimeout, clearTimeout,
        requestAnimationFrame: (f: () => void) => f(),
        I18N: { lang: 'ar', locale: () => 'ar-u-nu-latn-ca-gregory', t: (k: string) => k, strings: { ar: {}, en: {} } },
        t: (k: string) => k,
        navigator: { language: 'ar' },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: 'dashboard/js/components.js' });
    // `html`/`esc`/`safeUrl` are hoisted function declarations; `SafeHtml` is a class and
    // `UI` a const, so they live in the script's lexical scope rather than on globalThis.
    return vm.runInContext('({ html, esc, safeUrl, SafeHtml })', ctx) as Loaded;
}

const { html, esc, safeUrl, SafeHtml } = loadComponents();
const render = (v: unknown): string => String(html`${v}`);

describe('esc() — the single escaping function', () => {
    it('escapes every character that can break out of text or a quoted attribute', () => {
        assert.equal(esc('&'), '&amp;');
        assert.equal(esc('<'), '&lt;');
        assert.equal(esc('>'), '&gt;');
        assert.equal(esc('"'), '&quot;');
        assert.equal(esc("'"), '&#39;');
        assert.equal(esc('`'), '&#96;');
    });

    it('renders 0 rather than dropping it', () => {
        // `esc` drops null, undefined and false. 0 is falsy but is real data — a stat card
        // showing nothing instead of "0" is the bug this guards.
        assert.equal(esc(0), '0');
        assert.equal(render(0), '0');
    });

    it('drops null, undefined and false, so `${cond && ...}` renders nothing', () => {
        assert.equal(esc(null), '');
        assert.equal(esc(undefined), '');
        assert.equal(esc(false), '');
    });

    it('escapes arrays element-wise, so ${rows.map(...)} needs no join', () => {
        assert.equal(esc(['<a>', '<b>']), '&lt;a&gt;&lt;b&gt;');
    });

    it('passes SafeHtml through untouched, so templates nest without double-escaping', () => {
        const inner = html`<b>${'<x>'}</b>`;
        assert.equal(String(inner), '<b>&lt;x&gt;</b>');
        assert.equal(String(html`<p>${inner}</p>`), '<p><b>&lt;x&gt;</b></p>');
        assert.equal(esc(new SafeHtml('<hr>')), '<hr>');
    });
});

describe('the attack that actually happened', () => {
    it('renders a payload display name as text, not markup', () => {
        const name = '<img src=x onerror=alert(document.cookie)>';
        const out = String(html`<span>${name}</span>`);
        assert.equal(out, '<span>&lt;img src=x onerror=alert(document.cookie)&gt;</span>');
        assert.ok(!out.includes('<img'), 'no live img tag');
        assert.ok(!/on[a-z]+=/.test(out.replace(/&lt;[^&]*&gt;/g, '')), 'no live event handler');
    });

    it('cannot break out of a quoted attribute', () => {
        const evil = '" onmouseover="alert(1)';
        const out = String(html`<a title="${evil}">x</a>`);
        assert.equal(out, '<a title="&quot; onmouseover=&quot;alert(1)">x</a>');
        // Exactly two real quote characters remain: the ones this template wrote.
        assert.equal((out.match(/"/g) || []).length, 2);
    });

    it('closes a <script> body the only way escaping can', () => {
        assert.ok(!render('</script><script>alert(1)</script>').includes('</script>'));
    });
});

describe('the documented limit: escaping does NOT make an inline handler safe', () => {
    it('escaped output decodes back to a quote inside an event attribute', () => {
        // The HTML parser decodes &#39; before the JS is parsed, so
        // onclick="f('${value}')" is exploitable no matter how well esc() works. This is
        // why the dashboard uses data-action + delegated handlers, and this test exists so
        // the reasoning is executable rather than only a comment.
        const escaped = esc("');alert(1);//");
        assert.equal(escaped, '&#39;);alert(1);//');
        const decoded = escaped.replace(/&#39;/g, "'").replace(/&quot;/g, '"');
        assert.ok(decoded.includes("'"), 'the parser hands a real quote to the JS tokenizer');
    });
});

describe('html.raw() — the escape hatch', () => {
    it('passes a codebase literal through unescaped', () => {
        const raw = (html as unknown as { raw: (v: unknown) => object }).raw;
        assert.equal(String(html`<p>${raw('<br>')}</p>`), '<p><br></p>');
    });

    it('turns null and undefined into empty string rather than "null"', () => {
        const raw = (html as unknown as { raw: (v: unknown) => object }).raw;
        assert.equal(String(raw(null)), '');
        assert.equal(String(raw(undefined)), '');
    });
});

describe('safeUrl() — because escaping alone does not stop javascript:', () => {
    it('allows http and https', () => {
        assert.equal(safeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
        assert.equal(safeUrl('http://example.com'), 'http://example.com');
    });

    it('allows site-relative but never protocol-relative', () => {
        assert.equal(safeUrl('/dashboard/x'), '/dashboard/x');
        assert.equal(safeUrl('//evil.example.com/x'), '', 'protocol-relative borrows the page scheme');
    });

    it('allows only image data URLs', () => {
        assert.equal(safeUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
        assert.equal(safeUrl('data:text/html;base64,PHNjcmlwdD4='), '');
        assert.equal(safeUrl('data:image/svg+xml;base64,AAAA'), '', 'SVG can carry script');
    });

    it('rejects script schemes whatever the casing or padding', () => {
        for (const url of [
            'javascript:alert(1)', 'JaVaScRiPt:alert(1)', '  javascript:alert(1)  ',
            'vbscript:msgbox(1)', 'file:///etc/passwd', 'about:blank',
            'java\tscript:alert(1)', 'java\nscript:alert(1)',
        ]) {
            assert.equal(safeUrl(url), '', `rejected: ${JSON.stringify(url)}`);
        }
    });

    it('returns empty string for empty and non-string input rather than throwing', () => {
        for (const v of [null, undefined, '', '   ', 0, {}, []]) {
            let out: string | undefined;
            assert.doesNotThrow(() => { out = safeUrl(v); }, `input ${JSON.stringify(v)}`);
            assert.equal(typeof out, 'string');
        }
    });
});
