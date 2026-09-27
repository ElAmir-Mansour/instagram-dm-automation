/**
 * The REAL public pages, rendered the way src/index.ts serves them.
 *
 * publicPages.test.ts pins the template's rules on a toy page; this runs every file in
 * `public/` (and dashboard/eid.html) through `renderSiteTemplate` and checks what a visitor
 * would get: no token left behind, no hard-coded address, a contact channel on every page
 * whatever is configured, a stripping pass that removes the marked element and nothing
 * else, and the head a crawler reads in each language.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DEFAULT_CONTACT_EMAIL } from './appSettings.js';
import { renderSiteTemplate } from './publicPages.js';

const CHROME_PAGES = ['landing', 'pricing', 'privacy', 'terms', 'data-deletion', '404'] as const;
const INDEXED = ['landing', 'pricing', 'privacy', 'terms', 'data-deletion'] as const;
const FILES = [...CHROME_PAGES.map((p) => `public/${p}.html`), 'dashboard/eid.html'];

const ALL = { whatsappNumber: '966501234567', contactEmail: 'hello@example.com', eidCouponsExpire: '2026-04-05' };
/** What a deployment with nothing configured serves: the default email, nothing else. */
const BARE = { whatsappNumber: null, contactEmail: DEFAULT_CONTACT_EMAIL, eidCouponsExpire: null };

const read = (f: string) => readFileSync(f, 'utf8');
const metas = (html: string, name: string) =>
    [...html.matchAll(new RegExp(`<meta (?:name|property)="${name}"[^>]*content="([^"]*)"`, 'g'))].map((m) => m[1]!);

describe('public pages — the source files', () => {
    for (const f of FILES) {
        it(`${f} carries no hard-coded contact address`, () => {
            const src = read(f);
            assert.equal(src.includes('outlook.com'), false);
            for (const m of src.matchAll(/mailto:([^"'\s>]*)/g)) {
                // `mailto:` in a comment is prose; every real link is the token.
                if (m[1] === '' || m[1] === 'link.') continue;
                assert.equal(m[1], '{{CONTACT_EMAIL}}', `${f}: ${m[0]}`);
            }
        });
    }

    it('names every public page as a literal path in src/index.ts, and each exists', () => {
        // Vercel traces the function's files statically: a path built from a variable is
        // not bundled, and the page 500s in production only.
        const index = read('src/index.ts');
        const literals = [...index.matchAll(/path\.join\(__dirname, '\.\.\/((?:public|dashboard)\/[a-z0-9-]+\.html)'\)/g)].map((m) => m[1]!);
        for (const f of FILES) {
            assert.ok(literals.includes(f), `${f} must be a literal path.join(__dirname, '../${f}')`);
            assert.ok(existsSync(f), f);
        }
        assert.equal(/res\.sendFile\([^)]*\.html/.test(index), false, 'every page goes through renderPublicPage');
        // The Eid page is written in Arabic only; ?lang=en must not flip it to left-to-right.
        assert.match(index, /ARABIC_ONLY_PAGES[^=]*= new Set<PublicPage>\(\['eid'\]\)/);
    });
});

describe('public pages — rendered', () => {
    for (const f of FILES) {
        it(`${f}: no token survives, whatever is configured, in either language`, () => {
            for (const site of [ALL, BARE]) {
                for (const lang of ['ar', 'en'] as const) {
                    const out = renderSiteTemplate(read(f), site, lang);
                    assert.equal(/\{\{[A-Z_]+\}\}/.test(out), false, `${f} ${lang}`);
                }
            }
        });

        it(`${f}: stripping removes the marked elements and nothing else`, () => {
            const src = read(f);
            const full = renderSiteTemplate(src, ALL);
            const bare = renderSiteTemplate(src, BARE);
            assert.equal(bare.includes('data-when="whatsapp"'), false);
            assert.equal(bare.includes('wa.me'), false, 'no WhatsApp link without a number');
            // A regex that ran past its element would take kilobytes with it.
            const markedBytes = [...src.matchAll(/<(a|li|p|span|div|td)\b[^>]*\bdata-(?:when|unless)="[^"]+"[^>]*>[\s\S]*?<\/\1>/g)]
                .reduce((n, m) => n + m[0].length, 0);
            assert.ok(Math.abs(full.length - bare.length) <= markedBytes + 2000, `${f}: ${full.length} vs ${bare.length}`);
            for (const landmark of ['</main>', '</html>']) {
                assert.ok(full.includes(landmark) && bare.includes(landmark), `${f}: ${landmark}`);
            }
        });
    }

    for (const p of CHROME_PAGES) {
        it(`${p}: always keeps a way to reach someone, and offers WhatsApp when there is a number`, () => {
            const src = read(`public/${p}.html`);
            const bare = renderSiteTemplate(src, BARE);
            assert.ok(bare.includes(`href="mailto:${DEFAULT_CONTACT_EMAIL}"`), 'the default email is printed');
            const full = renderSiteTemplate(src, ALL);
            assert.ok(full.includes('href="https://wa.me/966501234567?text='), 'the footer offers WhatsApp');
            assert.ok(full.includes('href="mailto:hello@example.com"'));
        });

        it(`${p}: the header links to the contact block`, () => {
            const header = /<header class="topbar">[\s\S]*?<\/header>/.exec(read(`public/${p}.html`));
            assert.ok(header && header[0].includes('href="/#contact"'));
        });
    }

    it('landing: the contact block sits right after the hero, in both languages', () => {
        const src = read('public/landing.html');
        for (const lang of ['ar', 'en']) {
            const hero = src.indexOf(`aria-labelledby="hero-${lang}"`);
            const contact = src.indexOf(`id="contact-${lang}"`);
            const who = src.indexOf(`aria-labelledby="who-${lang}"`);
            assert.ok(hero > 0 && hero < contact && contact < who, lang);
        }
    });

    it('pricing: each tier CTA goes to WhatsApp when there is a number, else to the contact block', () => {
        const src = read('public/pricing.html');
        const ctas = (html: string) => [...html.matchAll(/<a class="cta"[^>]*href="([^"]*)"/g)].map((m) => m[1]!);
        const full = ctas(renderSiteTemplate(src, ALL));
        assert.equal(full.length, 6, 'three tiers, two languages');
        assert.ok(full.every((h) => h.startsWith('https://wa.me/')), full.join(' '));
        const bare = ctas(renderSiteTemplate(src, BARE));
        assert.deepEqual(bare, ['#contact-ar', '#contact-ar', '#contact-ar', '#contact-en', '#contact-en', '#contact-en']);
    });

    it('eid: the coupon expiry is the saved date, and blank (inert) when there is none', () => {
        const src = read('dashboard/eid.html');
        assert.ok(renderSiteTemplate(src, ALL).includes('data-coupons-expire="2026-04-05"'));
        assert.ok(renderSiteTemplate(src, BARE).includes('data-coupons-expire=""'));
    });
});

describe('public pages — what a crawler reads (PB4, PB10)', () => {
    for (const p of INDEXED) {
        it(`${p}: one Arabic description of at most 155 characters, and the English one on ?lang=en`, () => {
            const src = read(`public/${p}.html`);
            const ar = renderSiteTemplate(src, ALL, 'ar');
            const en = renderSiteTemplate(src, ALL, 'en');
            const [arDesc, ...arRest] = metas(ar, 'description');
            const [enDesc, ...enRest] = metas(en, 'description');
            assert.equal(arRest.length + enRest.length, 0, 'exactly one description per language');
            assert.ok(arDesc && /[؀-ۿ]/.test(arDesc) && arDesc.length <= 155, `${arDesc?.length}: ${arDesc}`);
            assert.ok(enDesc && !/[؀-ۿ]/.test(enDesc), enDesc);
            assert.equal(metas(ar, 'og:description')[0], arDesc);
            assert.equal(metas(en, 'og:description')[0], enDesc);
            assert.deepEqual(metas(en, 'og:locale'), ['en_US']);
            assert.ok(en.includes('<html lang="en" dir="ltr">'));
        });

        it(`${p}: hreflang ar / en / x-default, and a canonical per language`, () => {
            const src = read(`public/${p}.html`);
            const base = /<link rel="alternate" hreflang="ar" href="([^"]+)">/.exec(src)?.[1];
            assert.ok(base, 'hreflang ar');
            assert.ok(src.includes(`<link rel="alternate" hreflang="en" href="${base}?lang=en">`));
            assert.ok(src.includes(`<link rel="alternate" hreflang="x-default" href="${base}">`));
            assert.ok(renderSiteTemplate(src, ALL, 'ar').includes(`<link rel="canonical" href="${base}">`));
            assert.ok(renderSiteTemplate(src, ALL, 'en').includes(`<link rel="canonical" href="${base}?lang=en">`));
        });

        it(`${p}: picks the language from ?lang=, then the stored choice — never the browser locale`, () => {
            const src = read(`public/${p}.html`);
            assert.ok(src.includes("new URLSearchParams(location.search).get('lang')"));
            assert.equal(src.includes('navigator.language'), false);
        });
    }

    for (const p of ['privacy', 'terms'] as const) {
        it(`${p}: a contents list at the top of each language, and an id on every h2 it points to`, () => {
            const src = read(`public/${p}.html`);
            for (const lang of ['ar', 'en']) {
                const start = src.indexOf(`<article class="doc" data-doc-lang="${lang}"`);
                const article = src.slice(start, src.indexOf('</article>', start));
                const h2 = [...article.matchAll(/<h2([^>]*)>/g)];
                assert.ok(h2.length > 5, `${p} ${lang}`);
                const ids = h2.map((m) => /id="([^"]+)"/.exec(m[1]!)?.[1]);
                assert.ok(ids.every(Boolean), `${p} ${lang}: every h2 has an id`);
                const toc = /<nav class="toc"[\s\S]*?<\/nav>/.exec(article);
                assert.ok(toc, `${p} ${lang}: contents`);
                assert.ok(article.indexOf(toc[0]) < article.indexOf('<h2'), 'at the top');
                const links = [...toc[0].matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
                assert.deepEqual(links, ids, `${p} ${lang}: one link per section, in order`);
            }
        });
    }

    it('terms: a payment and notice section in both languages, where the written agreement prevails', () => {
        const src = read('public/terms.html');
        assert.ok(src.includes('id="payment-ar"') && src.includes('id="payment-en"'));
        assert.ok(src.includes('فالاتفاق المكتوب هو الذي يسري'));
        assert.ok(src.includes('the written\n                    agreement prevails') || src.includes('the written agreement prevails'));
    });
});
