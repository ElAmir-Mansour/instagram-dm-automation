/**
 * Keyboard focus never hides, and every Ads form uses the app's field style (UX wave 1: R2-X-6, R2-X-7, ADS-L1, ADS-L2).
 *
 *   - R2-X-6: a visually hidden file input sits RIGHT BEFORE its label, so `.file-input:focus-visible + .btn` can draw the ring.
 *   - R2-X-7: the sticky header, the Settings tab bar and any save bar are measured into `--sticky-top` / `--sticky-bottom`, and
 *     `html` scrolls a focused item clear of them (the composer's scroller too).
 *   - ADS-L1: `form-input` has no style, so no file in `dashboard/` may use it (ratchet); radios take the checkbox's size and accent.
 *   - ADS-L2: a field in error is `aria-invalid` and names its error in `aria-describedby`; the error is `--danger-text`.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const CSS = readFileSync('dashboard/css/styles.css', 'utf8');
const PAGES = 'dashboard/js/pages/';
const jsFiles = (): string[] => [...readdirSync('dashboard/js').filter((f) => f.endsWith('.js')).map((f) => `dashboard/js/${f}`),
    ...readdirSync(PAGES).filter((f) => f.endsWith('.js')).map((f) => PAGES + f)];

describe('R2-X-6: a hidden file input is followed by its label', () => {
    it('every input[type=file].sr-only is immediately followed by <label for=its id>', () => {
        let seen = 0;
        for (const file of jsFiles()) {
            const src = readFileSync(file, 'utf8');
            for (const m of src.matchAll(/<input\b[^>]*>/g)) {
                const tag = m[0];
                if (!/type="file"/.test(tag) || !/class="[^"]*\bsr-only\b/.test(tag)) continue;
                seen++;
                const id = /\bid="([^"]+)"/.exec(tag)?.[1];
                assert.ok(id, `${file}: a hidden file input needs an id`);
                const after = src.slice(m.index! + tag.length).replace(/^\s+/, '');
                const label = new RegExp(`^<label\\b[^>]*\\bfor="${id.replace(/[$.{}]/g, '\\$&')}"`);
                assert.match(after, label, `${file}: <input id="${id}"> must be followed by its <label>`);
                assert.match(tag, /\bfile-input\b/, `${file}: ${id} needs the file-input class, which draws the ring`);
            }
        }
        assert.ok(seen >= 4, `expected the Brand, Infographics, Explainers and welcome inputs, saw ${seen}`);
    });

    it('the stylesheet draws the ring on the label beside the focused input', () => {
        assert.match(CSS, /\.file-input:focus-visible \+ \.btn \{[^}]*outline: 2px solid var\(--accent\)/);
        assert.doesNotMatch(CSS, /welcome-file-input/);
    });
});

describe('R2-X-7: sticky bars never cover the focused field', () => {
    it('html scrolls clear of the measured bars, and the composer scroller keeps room for its action bar', () => {
        assert.match(CSS, /html \{[^}]*--sticky-top: var\(--header-height\);[^}]*--sticky-bottom: 0px;[^}]*scroll-padding-block: calc\(var\(--sticky-top\) \+ 8px\) calc\(var\(--sticky-bottom\) \+ 8px\);/);
        assert.match(CSS, /\.modal-content:has\(\.post-composer\) \{ scroll-padding-block-end: /);
    });

    it('App.syncStickyInsets measures the header, the Settings tab bar and a save bar into the two variables', () => {
        const rects: Record<string, number> = { '.page-header': 76, '.settings-tabbar': 56 };
        const bars: Json[] = [];
        const el = (h: number): Json => ({ offsetParent: {}, isConnected: true, getBoundingClientRect: () => ({ height: h }) });
        const props = new Map<string, string>();
        class RO { cb: () => void; constructor(cb: () => void) { this.cb = cb; } observe(): void {} unobserve(): void {} }
        class MO { constructor(public cb: () => void) {} observe(): void {} }
        const win: Json = { addEventListener() {} };
        const h = loadDashboard({ lang: 'en', app: true, globals: { ResizeObserver: RO, MutationObserver: MO, requestAnimationFrame: (f: () => void) => f(), window: win } });
        const doc = h.document as Json;
        doc.documentElement = { style: { setProperty: (k: string, v: string) => props.set(k, v) } };
        doc.querySelector = (sel: string) => (rects[sel] ? el(rects[sel]!) : null);
        doc.querySelectorAll = (sel: string) => (sel.includes('studio-savebar') && !sel.includes('page-header') ? bars : []);
        doc.body = {};
        const App = h.run('App') as Json;
        App.syncStickyInsets();
        assert.equal(props.get('--sticky-top'), '132px');
        assert.equal(props.get('--sticky-bottom'), '0px');
        bars.push(el(74));
        App.syncStickyInsets();
        assert.equal(props.get('--sticky-bottom'), '86px');
    });
});

describe('ADS-L1: one field style', () => {
    it('no dashboard file uses the unstyled form-input class (ratchet)', () => {
        const hits = [...jsFiles(), 'dashboard/index.html', 'dashboard/css/styles.css', ...readdirSync('dashboard/css/pages').map((f) => `dashboard/css/pages/${f}`)]
            .filter((f) => /\bform-input\b/.test(readFileSync(f, 'utf8')));
        assert.deepEqual(hits, []);
    });

    it('radios take the size and accent of checkboxes', () => {
        assert.match(CSS, /input\[type='radio'\] \{ accent-color: var\(--accent\); inline-size: 24px; block-size: 24px;/);
    });

    it('the two Ads layout rules follow the new names', () => {
        const ads = readFileSync('dashboard/css/pages/ads.css', 'utf8');
        assert.match(ads, /\.adsc-ice \.field \{/);
        assert.match(ads, /\.adsrule-cond \.field, \.adsrule-cond \.select \{/);
    });
});

describe('ADS-L2: errors are red and tied to their field', () => {
    it('.form-error is the danger text colour, with an alert icon when it has text', () => {
        assert.match(CSS, /\.form-error \{[^}]*color: var\(--danger-text\)/);
        assert.match(CSS, /\.form-error:not\(:empty\)::before \{/);
    });

    it('UI.linkError / unlinkError keep the field\'s own hint', () => {
        const h = loadDashboard({ lang: 'en' });
        const f = h.el('f1', {});
        f.setAttribute('aria-describedby', 'f1-hint');
        h.UI.linkError(f, 'e1');
        h.UI.linkError(f, 'e1');
        assert.equal(f.getAttribute('aria-invalid'), 'true');
        assert.equal(f.getAttribute('aria-describedby'), 'f1-hint e1');
        h.UI.unlinkError(f, 'e1');
        assert.equal(f.getAttribute('aria-invalid'), null);
        assert.equal(f.getAttribute('aria-describedby'), 'f1-hint');
    });

    it('UI.formError writes the line, links the field, and releases it when cleared', () => {
        const h = loadDashboard({ lang: 'en' });
        const host = h.el('x-error', {});
        const f = h.el('x-field', {});
        h.UI.formError(host, 'Bad <name>', { field: f });
        assert.match(String(host.innerHTML), /<p class="form-error" id="x-error-msg">Bad &lt;name&gt;<\/p>/);
        assert.equal(f.getAttribute('aria-invalid'), 'true');
        assert.equal(f.getAttribute('aria-describedby'), 'x-error-msg');
        h.UI.formError(host, '');
        assert.equal(host.innerHTML, '');
        assert.equal(f.getAttribute('aria-invalid'), null);
        assert.equal(f.getAttribute('aria-describedby'), null);
    });

    it('the builder\'s empty-name error is linked to the name field', async () => {
        const h = loadDashboard({ lang: 'en', files: ['dashboard/js/pages/ads_builder.js', 'dashboard/js/pages/ads_campaigns.js', 'dashboard/js/pages/ads_create.js'],
            globals: { API: { token: 'tok', getAdsSettings: async () => ({ configured: true, adAccountId: '1', limits: { maxDailyBudget: 50, monthlyCap: 500 }, account: { name: 'Main', currency: 'USD', minDailyBudget: 1 } }),
                getAdsMinimumBudgets: async () => ({ currency: 'USD', byGoal: {} }), getProfile: async () => ({ profile: { offers: [] } }), getScheduledPosts: async () => [],
                getAdsMoney: async () => ({ currency: 'USD', fits: true, remaining: 400, monthlyCap: 500, maxDailyBudget: 50 }) }, App: { canOperate: () => true, canAdminister: () => true } } });
        h.document.getElementById = (id: string) => h.el(id);
        h.el('page-container', {});
        h.UI.toast = () => null;
        const P = h.run('AdsCreatePage') as Json;
        await P.render();
        await settle();
        const name = h.el('adsc-name', {});
        name.setAttribute('aria-describedby', 'adsc-name-hint');
        h.UI._actions.adsc.next(h.el('n1', {}), { preventDefault() {}, stopPropagation() {} });
        assert.equal(name.getAttribute('aria-invalid'), 'true');
        assert.equal(name.getAttribute('aria-describedby'), 'adsc-name-hint adsc-err-name');
        assert.match(String(h.el('adsc-step').innerHTML), /id="adsc-err-name"[^>]*>[^<]+<\/p>/);
    });
});
