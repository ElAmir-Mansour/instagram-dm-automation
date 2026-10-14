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

// ─── The setup wizard (P18): a payload in every field a person or the server fills in ────────────

/**
 * The wizard (`dashboard/js/pages/welcome.js`) shows more of other people's text than any screen before it: what a tenant typed
 * into each step, the profile's fields, the operator's hints, a workspace's name, the server's list of problems. This loads the
 * real file beside `components.js` and renders every step with an injection payload in each of those, so the one defence on this
 * page (`html` and `esc`) is shown to hold there as well. `welcome.test.ts` runs the same view through the real dictionaries and
 * every state; this is the case `docs/onboarding/02 §5` asks for in this file.
 */
describe('the wizard escapes a payload in every field it shows', () => {
    const PAYLOAD = '<img src=x onerror=alert(document.cookie)>';
    const BREAKOUT = '"><script>alert(1)</script><x y="';
    const noop = (): void => {};

    function loadWelcome(): { P: any } {
        const stubEl = {
            addEventListener: noop, removeEventListener: noop, querySelectorAll: () => [], querySelector: () => null, appendChild: noop,
            setAttribute: noop, getAttribute: () => null, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
            style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null, contains: () => false, children: [],
        };
        const ctx: Record<string, unknown> = {
            document: { ...stubEl, createElement: () => ({ ...stubEl }), body: { ...stubEl }, head: { ...stubEl }, documentElement: { ...stubEl, lang: 'ar', dir: 'rtl' }, getElementById: () => null, activeElement: null },
            window: { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '' } },
            Intl, console, setTimeout, clearTimeout, requestAnimationFrame: (f: () => void) => f(),
            I18N: { lang: 'en', locale: () => 'en-US', t: (k: string) => k, strings: { ar: {}, en: {} } },
            t: (k: string, p?: Record<string, unknown>) => (p && p.word !== undefined ? `${k}:${String(p.word)}` : k),
            navigator: { language: 'en', userAgent: '' }, sessionStorage: { getItem: () => null, setItem: noop }, localStorage: { getItem: () => null, setItem: noop },
        };
        ctx.globalThis = ctx;
        vm.createContext(ctx);
        for (const file of ['dashboard/js/components.js', 'dashboard/js/pages/welcome.js']) vm.runInContext(readFileSync(file, 'utf8'), ctx, { filename: file });
        return { P: vm.runInContext('WelcomePage', ctx) };
    }

    const { P } = loadWelcome();
    const everyValue = {
        name: PAYLOAD, kind: PAYLOAD, niche: BREAKOUT, offerName: PAYLOAD, orderVia: PAYLOAD, offerUrl: BREAKOUT, price: PAYLOAD, country: PAYLOAD, timezone: PAYLOAD,
        register: PAYLOAD, tone: [PAYLOAD, BREAKOUT], primary: PAYLOAD, accent: BREAKOUT, theme: PAYLOAD, handle: PAYLOAD, site: BREAKOUT, portraitUrl: 'javascript:alert(1)',
    };
    const profile = {
        identity: { display_name: { ar: PAYLOAD, en: BREAKOUT }, brand_name: PAYLOAD, kind: PAYLOAD, role: PAYLOAD, niche: PAYLOAD, country: PAYLOAD, timezone: PAYLOAD },
        language: { primary: 'ar', register: PAYLOAD, digits: PAYLOAD, surfaces: {} },
        offers: [{ id: PAYLOAD, kind: PAYLOAD, name: PAYLOAD, order_via: PAYLOAD, url: BREAKOUT, price: PAYLOAD, facts: [PAYLOAD], bullets: [PAYLOAD], keyword: PAYLOAD, primary: true }],
        voice: { guide: PAYLOAD, tone: [PAYLOAD], samples: [PAYLOAD], use_words: [PAYLOAD], avoid_words: [PAYLOAD], emoji: PAYLOAD, address: PAYLOAD },
        content: { domain: PAYLOAD, pillars: [PAYLOAD], never_mention: [PAYLOAD], rules: [PAYLOAD], custom_rules: [PAYLOAD] },
        brand: { primary: PAYLOAD, accent: BREAKOUT, font_display: PAYLOAD, logo_url: PAYLOAD, portrait_url: 'javascript:alert(1)', theme: PAYLOAD },
        socials: { handle: PAYLOAD, site: BREAKOUT, platforms: [PAYLOAD], links: { instagram: PAYLOAD } },
    };
    const order = ['about', 'voice', 'brand', 'connect', 'proof', 'done'].map((id, i) => ({ id, code: `W${i + 1}`, required: i < 2, enabled: id !== 'connect' && id !== 'proof' }));
    const onb = {
        status: 'in_progress', step: 'about', order, profile, version: 7, missing: [PAYLOAD],
        steps: { about: { values: everyValue }, voice: { values: everyValue }, brand: { values: everyValue } },
        hints: { name: PAYLOAD, instagramUsername: BREAKOUT, websiteUrl: PAYLOAD }, canEdit: true,
    };

    for (const step of ['about', 'voice', 'brand', 'done']) {
        it(`${step}: nothing is a live tag, handler or address, and the text is there as text`, () => {
            const state = P.freshState();
            state.phase = 'ready';
            state.onb = onb;
            state.step = step;
            state.values = P.STEPS[step].initial(onb, false);
            state.problems = [PAYLOAD, BREAKOUT];
            state.notice = 'conflict';
            state.tenants = [{ id: PAYLOAD, name: PAYLOAD }, { id: BREAKOUT, name: BREAKOUT }];
            state.tenantId = BREAKOUT;
            state.rulesOpen = true;
            const out = String(P.view(state));
            assert.ok(!out.includes('<img src=x'), 'no live img tag');
            assert.ok(!out.includes('<script'), 'no live script tag');
            assert.ok(!/"\s*>\s*<(script|img|x)\b/i.test(out), 'nothing broke out of an attribute');
            assert.ok(!/javascript:/i.test(out), 'no javascript: address in the page');
            assert.ok(!/\son[a-z]+\s*=/i.test(out.replace(/&lt;[^<>]*/g, '')), 'no live event handler');
            assert.ok(out.includes('&lt;img src=x onerror=alert('), 'and the payload is there, escaped, as the text it is');
        });
    }
});
