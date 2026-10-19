/**
 * What the public pages tell a crawler and a link preview (landing plan L5), and what they cost to serve (L6).
 *
 * Everything here runs the pages the way `src/index.ts` serves them: `compactPublicPage` once on the file, then
 * `renderSiteTemplate` per request with a language and an origin. Three groups of claims:
 *
 *   - L5, per language: exactly one title, description and og:image; the share card is the committed PNG for that language; the
 *     JSON-LD parses and claims no price, offer, rating or review; `/robots.txt` and `/sitemap.xml` answer on the wire, name the
 *     saved origin, and list exactly the pages that declare themselves indexable.
 *   - L6: no `<!--` survives into any served page, in either language, with any settings; each page is at most 220 KB (1 KB = 1000
 *     bytes, as in the other size tests; 215 KB until the landing's platform strip, 2026-10-19); and the sweep removed comments and indentation and nothing else.
 *   - The tokenizer behind L6, on the inputs a regex gets wrong: a comment that mentions `<style>`, a `<!--` inside a script, a
 *     style string or an attribute, a conditional comment, `<pre>`.
 *
 * The identity that stays put (the favicon file, the root routes that serve the icon set) is pinned: the Kufi «رد» mark replaced
 * Lucide's zap in B5, and these change again only on purpose, in a PR that changes the logo. The icon files themselves are held to
 * the pixel by `npm run check:brand-icons`.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { DEFAULT_CONTACT_EMAIL, type SiteSettings } from './appSettings.js';
import { compactCss, compactPublicPage, PRODUCTION_ORIGIN, renderSiteTemplate, type PageLang } from './publicPages.js';
import { INDEXED_PATHS, robotsTxt, sitemapXml } from './seo.js';
import { createSeoRouter } from '../routes/seo.js';
import { setLogSink } from '../utils/log.js';

const read = (f: string) => readFileSync(f, 'utf8');

/** The five pages meant to be found, by the path they are served at. */
const INDEXED: Record<string, string> = {
    '/': 'public/landing.html',
    '/pricing': 'public/pricing.html',
    '/privacy': 'public/privacy.html',
    '/terms': 'public/terms.html',
    '/data-deletion': 'public/data-deletion.html',
};
/** Everything `src/index.ts` serves through `renderPublicPage`. */
const SERVED = [...Object.values(INDEXED), 'public/404.html', 'dashboard/eid.html'];

const ALL: SiteSettings = { whatsappNumber: '966501234567', contactEmail: 'hello@example.com', eidCouponsExpire: '2026-04-05' };
const BARE: SiteSettings = { whatsappNumber: null, contactEmail: DEFAULT_CONTACT_EMAIL, eidCouponsExpire: null };
const LANGS: readonly PageLang[] = ['ar', 'en'];
const ORIGIN = 'https://example.org';

/** What a visitor is sent: the file, compacted once, rendered for a language, an origin and a set of settings. */
const compact = new Map<string, string>(SERVED.map((f) => [f, compactPublicPage(read(f))]));
const served = (file: string, lang: PageLang, site = ALL, origin = ORIGIN) => renderSiteTemplate(compact.get(file)!, site, lang, origin);

const ARABIC = /[؀-ۿ]/;
const metas = (html: string, key: string) =>
    [...html.matchAll(new RegExp(`<meta (?:name|property)="${key}"[^>]*content="([^"]*)"`, 'g'))].map((m) => m[1]!);
const titles = (html: string) => [...html.matchAll(/<title\b[^>]*>([^<]*)<\/title>/g)].map((m) => m[1]!);
const jsonLd = (html: string) => [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);

const manifest = JSON.parse(read('scripts/og/manifest.json')) as { images: Record<PageLang, { file: string; sha256: string; bytes: number }> };

// ─── L5: titles, descriptions, share cards ───────────────────────────────────────────────────────────────────────────

describe('L5 — one title, description and og:image per language, on every indexed page', () => {
    for (const [path, file] of Object.entries(INDEXED)) {
        for (const lang of LANGS) {
            it(`${path} (${lang}): one title, one description, one og:image, and the same words in og: and twitter:`, () => {
                const html = served(file, lang);
                const [title, ...moreTitles] = titles(html);
                assert.equal(moreTitles.length, 0, 'exactly one <title>');
                assert.ok(title && title.length >= 10 && title.length <= 80, `${title?.length}: ${title}`);
                assert.equal(ARABIC.test(title), lang === 'ar', title);
                assert.ok(/AutoReply Pro|أوتوريبلاي برو/.test(title), 'names the product');
                assert.deepEqual(metas(html, 'og:title'), [title]);
                assert.deepEqual(metas(html, 'twitter:title'), [title]);

                const description = metas(html, 'description');
                assert.equal(description.length, 1, 'exactly one description');
                assert.equal(ARABIC.test(description[0]!), lang === 'ar');
                assert.deepEqual(metas(html, 'og:description'), description);
                assert.deepEqual(metas(html, 'twitter:description'), description);
                assert.notEqual(description[0], title);

                const card = `${ORIGIN}/brand/${manifest.images[lang].file}`;
                assert.deepEqual(metas(html, 'og:image'), [card], 'exactly one og:image, this language\'s card, on the saved origin');
                assert.deepEqual(metas(html, 'twitter:image'), [card]);
                assert.deepEqual(metas(html, 'og:image:width'), ['1200']);
                assert.deepEqual(metas(html, 'og:image:height'), ['630']);
                assert.deepEqual(metas(html, 'og:image:type'), ['image/png']);
                assert.deepEqual(metas(html, 'twitter:card'), ['summary_large_image']);
                const alt = metas(html, 'og:image:alt');
                assert.equal(alt.length, 1);
                assert.equal(ARABIC.test(alt[0]!), lang === 'ar');
                assert.deepEqual(metas(html, 'twitter:image:alt'), alt);

                const canonical = /<link rel="canonical" href="([^"]+)">/.exec(html)?.[1];
                assert.equal(canonical, `${ORIGIN}${path}${lang === 'en' ? '?lang=en' : ''}`);
                assert.deepEqual(metas(html, 'og:url'), [canonical]);
                assert.deepEqual(metas(html, 'og:locale'), [lang === 'ar' ? 'ar_SA' : 'en_US']);
            });
        }
    }

    it('no two pages share a title or a description in the same language', () => {
        for (const lang of LANGS) {
            const t = Object.values(INDEXED).map((f) => titles(served(f, lang))[0]);
            const d = Object.values(INDEXED).map((f) => metas(served(f, lang), 'description')[0]);
            assert.equal(new Set(t).size, t.length, `${lang} titles: ${t.join(' | ')}`);
            assert.equal(new Set(d).size, d.length, `${lang} descriptions`);
        }
    });

    it('the landing title is the planned one, and is the product name plus what it is', () => {
        assert.equal(titles(served('public/landing.html', 'ar'))[0], 'أوتوريبلاي برو — استوديو نموّ لصنّاع المحتوى العرب');
        assert.equal(titles(served('public/landing.html', 'en'))[0], 'AutoReply Pro — a growth studio for Arabic creators');
    });

    it('the 404 stays out of search: noindex, and it carries no share card or per-language title', () => {
        const html = served('public/404.html', 'ar');
        assert.deepEqual(metas(html, 'robots'), ['noindex']);
        assert.deepEqual(metas(html, 'og:image'), []);
        assert.equal(titles(html).length, 1);
    });

    for (const lang of LANGS) {
        it(`the ${lang} share card is the committed PNG: 1200x630, under 300 KB, named for its own hash, text only`, () => {
            const rec = manifest.images[lang];
            const path = `public/brand/${rec.file}`;
            assert.ok(existsSync(path), path);
            const bytes = readFileSync(path);
            assert.equal(bytes.length, rec.bytes);
            assert.ok(bytes.length <= 300 * 1000, `${bytes.length} bytes`);
            assert.equal(bytes.toString('latin1', 1, 4), 'PNG');
            assert.equal(bytes.readUInt32BE(16), 1200);
            assert.equal(bytes.readUInt32BE(20), 630);
            assert.equal(createHash('sha256').update(bytes).digest('hex').slice(0, 8), rec.file.split('.')[1]);
        });
    }

    it('vercel.json serves the cards from /brand, immutable, and sends robots.txt and sitemap.xml to the function', () => {
        const { routes } = JSON.parse(read('vercel.json')) as { routes: Array<{ src: string; dest?: string; headers?: Record<string, string> }> };
        const first = (path: string) => routes.find((r) => new RegExp(`^${r.src}$`).test(path));
        const card = first(`/brand/${manifest.images.ar.file}`);
        assert.equal(card?.dest, 'public/brand/$1');
        assert.match(card?.headers?.['Cache-Control'] ?? '', /immutable/);
        for (const p of ['/robots.txt', '/sitemap.xml']) assert.equal(first(p)?.dest, 'src/index.ts', `${p} must reach the function, ahead of nothing that could shadow it`);
    });
});

// ─── L5: JSON-LD ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every key in a JSON tree, at any depth. */
function keys(node: unknown, out: string[] = []): string[] {
    if (Array.isArray(node)) node.forEach((n) => keys(n, out));
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) (out.push(k), keys(v, out));
    return out;
}

describe('L5 — JSON-LD: parses, one block per language, and claims no price, offer, rating or review', () => {
    for (const lang of LANGS) {
        it(`landing (${lang}): exactly one block; a WebSite, a SoftwareApplication and the founder as a Person`, () => {
            const html = served('public/landing.html', lang);
            const blocks = jsonLd(html);
            assert.equal(blocks.length, 1);
            const data = JSON.parse(blocks[0]!) as { '@context': string; '@graph': Array<Record<string, unknown>> };
            assert.equal(data['@context'], 'https://schema.org');
            const byType = new Map(data['@graph'].map((n) => [n['@type'] as string, n]));
            assert.deepEqual([...byType.keys()].sort(), ['Person', 'SoftwareApplication', 'WebSite']);

            const app = byType.get('SoftwareApplication')!;
            assert.equal(app.applicationCategory, 'BusinessApplication');
            assert.equal(app.operatingSystem, 'Web');
            assert.equal(app.name, 'AutoReply Pro');
            assert.equal(app.alternateName, 'أوتوريبلاي برو');
            assert.deepEqual(app.inLanguage, ['ar', 'en']);
            const description = metas(html, 'description')[0];
            assert.equal(app.description, description, 'the same sentence the meta description says');
            assert.equal(byType.get('WebSite')!.description, description);
            assert.equal(app.url, `${ORIGIN}/`);
            assert.equal(byType.get('WebSite')!.url, `${ORIGIN}/`);

            // Every @id and url is on the saved origin, and every @id reference resolves.
            const ids = new Set(data['@graph'].map((n) => n['@id']));
            for (const n of data['@graph']) assert.ok(String(n['@id']).startsWith(`${ORIGIN}/#`), String(n['@id']));
            for (const ref of [(app.author as { '@id': string })['@id'], (app.provider as { '@id': string })['@id'], (byType.get('WebSite')!.publisher as { '@id': string })['@id']]) {
                assert.ok(ids.has(ref), `unresolved ${ref}`);
            }

            const person = byType.get('Person')!;
            assert.equal(person.name, 'ElAmir Mansour');
            // sameAs is only ever an account the page itself links as the founder's.
            for (const url of person.sameAs as string[]) assert.ok(html.includes(`href="${url}"`), `${url} is not a link on the page`);
            assert.equal((person.sameAs as string[]).length, 4);
            assert.equal(html.includes('{{'), false);
        });

        it(`landing (${lang}): no offers, no ratings, no reviews, no price, no free claim`, () => {
            const blocks = jsonLd(served('public/landing.html', lang));
            const forbidden = /^(offers?|aggregateRating|rating|ratingValue|ratingCount|bestRating|review|reviews|reviewCount|price|priceCurrency|priceRange|lowPrice|highPrice|isAccessibleForFree|featureList|screenshot|downloadUrl|softwareVersion|datePublished)$/i;
            const bad = keys(JSON.parse(blocks[0]!)).filter((k) => forbidden.test(k));
            assert.deepEqual(bad, []);
        });
    }

    it('only the landing carries JSON-LD: the other pages make no structured claim', () => {
        for (const file of SERVED) {
            for (const lang of LANGS) assert.equal(jsonLd(served(file, lang)).length, file === 'public/landing.html' ? 1 : 0, `${file} ${lang}`);
        }
    });

    it('moves with the saved origin', () => {
        const data = JSON.parse(jsonLd(served('public/landing.html', 'en', ALL, 'https://example.net'))[0]!) as { '@graph': Array<{ url?: string }> };
        assert.ok(data['@graph'].filter((n) => n.url).every((n) => n.url === 'https://example.net/'));
    });
});

// ─── L5: robots.txt and sitemap.xml ──────────────────────────────────────────────────────────────────────────────────

describe('L5 — /robots.txt and /sitemap.xml, on the wire', () => {
    let server: Server;
    let base: string;
    let origin = ORIGIN;
    let failing = false;
    let restoreSink: (() => void) | undefined;

    before(async () => {
        const previous = setLogSink(() => {});
        restoreSink = () => { setLogSink(previous); };
        const app = express();
        app.use(createSeoRouter({ getOrigin: async () => { if (failing) throw new Error('no settings'); return origin; } }));
        app.use((_req, res) => { res.status(404).type('text/plain').send('fell through'); });
        server = await new Promise<Server>((done) => { const s = app.listen(0, '127.0.0.1', () => done(s)); });
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => new Promise<void>((done) => { restoreSink?.(); server.close(() => done()); server.closeAllConnections(); }));

    it('robots.txt: plain text, open by default, /dashboard and /api disallowed with the two folders the pages and the platforms need allowed, and the sitemap named', async () => {
        origin = ORIGIN;
        const res = await fetch(`${base}/robots.txt`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
        assert.match(res.headers.get('cache-control') ?? '', /s-maxage=300/);
        const body = await res.text();
        const rules = body.split('\n').filter((l) => /^(Allow|Disallow|User-agent|Sitemap):/.test(l));
        assert.deepEqual(rules, [
            'User-agent: *',
            'Allow: /dashboard/css/',
            'Allow: /api/uploads/',
            'Disallow: /dashboard',
            'Disallow: /api',
            `Sitemap: ${ORIGIN}/sitemap.xml`,
        ]);
        // The public pages load /dashboard/css/tokens.css; a crawler locked out of it would judge them unstyled.
        for (const p of Object.values(INDEXED)) assert.match(read(p), /href="\/dashboard\/css\/tokens\.css\?v=/, p);
        // Every Allow comes before the Disallow it narrows, for parsers that take the first match.
        assert.ok(rules.indexOf('Allow: /dashboard/css/') < rules.indexOf('Disallow: /dashboard'));
        assert.ok(rules.indexOf('Allow: /api/uploads/') < rules.indexOf('Disallow: /api'));
        assert.equal(/Disallow:\s*\/\s*$/m.test(body), false, 'the site itself is not disallowed');
    });

    it('sitemap.xml: XML, ten URLs (five pages, two languages), each with the whole ar / en / x-default set, all on the saved origin', async () => {
        origin = 'https://example.net/';
        const res = await fetch(`${base}/sitemap.xml`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /^application\/xml/);
        const body = await res.text();
        assert.ok(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
        const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
        assert.equal(locs.length, 10);
        assert.equal(new Set(locs).size, 10);
        assert.ok(locs.every((l) => l.startsWith('https://example.net/') && !l.includes('//', 'https://'.length)), locs.join(' '));
        for (const url of body.split('<url>').slice(1)) {
            const alternates = [...url.matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
            assert.equal(alternates.length, 3);
            assert.deepEqual(alternates.map((a) => a.split(' ')[0]), ['ar', 'en', 'x-default']);
        }
        assert.equal(/<lastmod>/.test(body), false, 'no invented dates');
    });

    it('sitemap.xml lists exactly the pages that declare themselves indexable, at the URLs they declare', async () => {
        origin = ORIGIN;
        const body = await (await fetch(`${base}/sitemap.xml`)).text();
        const locs = new Set([...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!));
        assert.deepEqual([...INDEXED_PATHS].sort(), Object.keys(INDEXED).sort(), 'the sitemap and this test name the same pages');
        for (const [path, file] of Object.entries(INDEXED)) {
            for (const lang of LANGS) {
                const html = served(file, lang);
                assert.equal(metas(html, 'robots').includes('noindex'), false, `${file} is not noindex`);
                const canonical = /<link rel="canonical" href="([^"]+)">/.exec(html)![1]!;
                assert.ok(locs.has(canonical), `${canonical} (${file} ${lang}) is in the sitemap`);
                const hreflang = Object.fromEntries([...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => [m[1], m[2]]));
                assert.deepEqual(Object.keys(hreflang).sort(), ['ar', 'en', 'x-default']);
                assert.ok(locs.has(hreflang.ar!) && locs.has(hreflang.en!), `${path}: both language URLs are listed`);
            }
        }
        // Nothing the sitemap lists is a page that opts out, and the 404 and the login are not in it.
        assert.equal([...locs].some((l) => /\/(404|dashboard|eid|api)\b/.test(l)), false);
    });

    it('HEAD answers like GET, a failed origin read is a 500 and not a guess, and nothing else is claimed', async () => {
        origin = ORIGIN;
        for (const p of ['/robots.txt', '/sitemap.xml']) {
            const head = await fetch(`${base}${p}`, { method: 'HEAD' });
            assert.equal(head.status, 200, p);
            failing = true;
            assert.equal((await fetch(`${base}${p}`)).status, 500, p);
            failing = false;
        }
        assert.equal((await fetch(`${base}/robots.txt/x`)).status, 404);
        assert.equal((await fetch(`${base}/sitemap.xml?lang=en`)).status, 200, 'a query string is ignored');
    });

    it('the builders are pure and agree with the router', () => {
        assert.equal(robotsTxt(`${ORIGIN}/`), robotsTxt(ORIGIN));
        assert.equal(sitemapXml(`${ORIGIN}//`), sitemapXml(ORIGIN));
        assert.ok(robotsTxt(PRODUCTION_ORIGIN).endsWith(`Sitemap: ${PRODUCTION_ORIGIN}/sitemap.xml\n`));
    });

    it('src/index.ts mounts the router on the saved origin, and serves every page from the compacted source', () => {
        const index = read('src/index.ts');
        assert.match(index, /app\.use\(createSeoRouter\(\{ getOrigin: getSiteOrigin \}\)\)/);
        assert.match(index, /readFile\(PUBLIC_PAGES\[page\], 'utf8'\)\.then\(compactPublicPage\)/);
        assert.match(index, /renderSiteTemplate\(await source, site, lang, origin\)/);
        assert.match(index, /const origin = await getSiteOrigin\(\)/);
    });
});

// ─── L6: what is served ──────────────────────────────────────────────────────────────────────────────────────────────

// 215 KB until 2026-10-19: the landing's platform strip (+4.0 KB served) was asked for by the owner. See brandMotif.test.ts, which holds the same figure.
const BUDGET = 220 * 1000;

describe('L6 — what is served: no comment, and at most 220 KB', () => {
    for (const file of SERVED) {
        it(`${file}: no "<!--" in either language, with every setting on or off`, () => {
            for (const lang of LANGS) {
                for (const site of [ALL, BARE]) {
                    const out = served(file, lang, site);
                    assert.equal(out.includes('<!--'), false, `${file} ${lang}`);
                    assert.equal(out.includes('-->'), false, `${file} ${lang}: no stray comment close either`);
                    assert.equal(/\{\{[A-Z_]+\}\}/.test(out), false, `${file} ${lang}: no token survives`);
                }
            }
        });

        it(`${file}: at most ${BUDGET} bytes served, in either language`, () => {
            const sizes = LANGS.flatMap((lang) => [ALL, BARE].map((site) => Buffer.byteLength(served(file, lang, site))));
            assert.ok(Math.max(...sizes) <= BUDGET, `${file}: ${Math.max(...sizes)} bytes`);
        });
    }

    it('the landing, the one page that was over budget, is served well under it (the room left is the margin for copy)', () => {
        const worst = Math.max(...LANGS.flatMap((lang) => [ALL, BARE].map((site) => Buffer.byteLength(served('public/landing.html', lang, site)))));
        assert.ok(worst <= BUDGET - 3000, `${worst} bytes leaves under 3 KB of room`);
        assert.ok(statSync('public/landing.html').size > BUDGET, 'the source file is over it, so the sweep is what meets the budget');
    });

    it('each file is compacted once: running it again changes nothing', () => {
        for (const file of SERVED) assert.equal(compactPublicPage(compact.get(file)!), compact.get(file), file);
    });
});

/** The document split into the parts the sweep must not change (script bodies, style bodies) and the markup between them. */
function parts(html: string): { markup: string; scripts: string[]; styles: string[] } {
    const scripts: string[] = [];
    const styles: string[] = [];
    const markup = html.replace(/(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi, (_m, open: string, tag: string, body: string, close: string) => {
        (tag.toLowerCase() === 'script' ? scripts : styles).push(body);
        return `${open}${close}`;
    });
    return { markup, scripts, styles };
}

describe('L6 — the sweep removes comments and blanks, and nothing else', () => {
    for (const file of SERVED) {
        it(`${file}: every script is byte for byte, every style differs only in comments and blanks, the markup only in comments and indentation`, () => {
            const src = read(file);
            // The reference is the obvious regex pair: comments out of the whole file first (so a comment that mentions <style> cannot be taken
            // for a block), then the comments out of each stylesheet. It is valid here because nothing in these files puts "<!--" in a script, a
            // style or an attribute: if one did, the regex would mangle it, the sweep would not, and the comparison below would fail by name.
            const before = parts(src.replace(/<!--[\s\S]*?-->/g, ''));
            const reference = { markup: before.markup, scripts: before.scripts, styles: before.styles.map((css) => css.replace(/\/\*[\s\S]*?\*\//g, '')) };
            const after = parts(compact.get(file)!);

            assert.deepEqual(after.scripts, reference.scripts, `${file}: a script changed`);
            assert.equal(after.styles.length, reference.styles.length);
            reference.styles.forEach((css, i) => assert.equal(after.styles[i]!.replace(/\s+/g, ''), css.replace(/\s+/g, ''), `${file}: style ${i} lost more than comments and blanks`));
            // Markup: the same text and tags once every run of whitespace is one space (that is how a browser reads it).
            assert.equal(after.markup.replace(/\s+/g, ' '), reference.markup.replace(/\s+/g, ' '), `${file}: the markup changed beyond comments and indentation`);
            // And no indentation is left in it, which is what it was for.
            assert.equal(/\n[ \t]+\S/.test(after.markup.replace(/<[^>]*>/g, (t) => t.replace(/\n/g, ' '))), false, `${file}: indentation survived`);
        });
    }

    it('no page sets white-space: pre* on anything, which is what makes dropping indentation safe', () => {
        for (const file of SERVED) assert.equal(/white-space\s*:\s*pre/i.test(read(file)), false, file);
        assert.equal(/white-space\s*:\s*pre/i.test(read('dashboard/css/tokens.css')), false, 'the stylesheet every public page loads');
        for (const file of SERVED) assert.equal(/<(pre|textarea)\b/i.test(read(file)), false, `${file} holds a <pre> or <textarea>, whose whitespace is its content`);
    });
});

// ─── L6: the tokenizer, on what a regex gets wrong ───────────────────────────────────────────────────────────────────

describe('compactPublicPage — HTML', () => {
    it('removes a comment and leaves no blank line, joining the text on both sides', () => {
        assert.equal(compactPublicPage('<div>\n    <!-- a note -->\n    <p>x</p>\n</div>'), '<div>\n<p>x</p>\n</div>');
        assert.equal(compactPublicPage('<p>one<!-- x -->two</p>'), '<p>onetwo</p>');
        assert.equal(compactPublicPage('<!-- a\n   multi-line\n   note -->\n<p>x</p>'), '\n<p>x</p>');
    });

    it('does not read a comment that merely mentions <style> or <script> as a block', () => {
        const out = compactPublicPage('<!-- the <style> block and <script> below -->\n<p>x</p>\n<style>a { color: red; }</style>\n<!-- end -->\n');
        assert.equal(out, '\n<p>x</p>\n<style>a{color:red;}</style>\n');
    });

    it('keeps a "<!--" that is script text, style text or an attribute value', () => {
        const script = '<script>var s = "<!-- not a comment -->"; var t = \'<!--\';</script>';
        assert.equal(compactPublicPage(script), script);
        assert.equal(compactPublicPage('<style>p::after{content:"<!-- x -->"}</style>'), '<style>p::after{content:"<!-- x -->"}</style>');
        const attr = '<a title="<!-- x -->" href="/">y</a>';
        assert.equal(compactPublicPage(attr), attr);
        const single = "<a data-x='<!--' href=\"/\">y</a><!-- z -->";
        assert.equal(compactPublicPage(single), "<a data-x='<!--' href=\"/\">y</a>");
        const gt = '<a title="a > b" href="/">y</a> <!-- c -->';
        assert.equal(compactPublicPage(gt), '<a title="a > b" href="/">y</a> ');
    });

    it('keeps an IE conditional comment, which is content, and drops the one beside it', () => {
        const out = compactPublicPage('<!--[if lt IE 9]><script src="x.js"></script><![endif]--><!-- plain -->');
        assert.equal(out, '<!--[if lt IE 9]><script src="x.js"></script><![endif]-->');
    });

    it('leaves an unclosed comment exactly as it is rather than guess where it ends', () => {
        const unclosed = '<p>x</p><!-- never closed\n    <p>y</p>';
        assert.equal(compactPublicPage(unclosed), unclosed);
    });

    it('keeps every character of <pre>, <textarea> and <title>', () => {
        assert.equal(compactPublicPage('<pre>\n    a\n\n\n    b\n</pre>'), '<pre>\n    a\n\n\n    b\n</pre>');
        assert.equal(compactPublicPage('<textarea>\n   <!-- keep -->\n   </textarea>'), '<textarea>\n   <!-- keep -->\n   </textarea>');
        assert.equal(compactPublicPage('<title>a <!-- b --> c</title>'), '<title>a <!-- b --> c</title>');
        assert.equal(compactPublicPage('<pre><b>\n  x</b>\n  y</pre>\n   <p>z</p>'), '<pre><b>\n  x</b>\n  y</pre>\n<p>z</p>');
    });

    it('strips indentation and blank runs from text, never a line break itself, and never the space inside a line', () => {
        assert.equal(compactPublicPage('<p>\n        one\n\n\n        two  three   \n    </p>'), '<p>\none\ntwo  three\n</p>');
        assert.equal(compactPublicPage('<a>x</a>   <a>y</a>'), '<a>x</a>   <a>y</a>');
        assert.equal(compactPublicPage('<ul>\r\n    <li>x</li>\r\n</ul>'), '<ul>\n<li>x</li>\n</ul>');
    });

    it('reads a "<" that opens nothing as text, and a self-closing tag as a tag', () => {
        assert.equal(compactPublicPage('<p>1 < 2 and 3 <4</p>\n    <br/>\n    <p>x</p>'), '<p>1 < 2 and 3 <4</p>\n<br/>\n<p>x</p>');
    });

    it('leaves the doctype, a CDATA section and an unknown script type alone', () => {
        const doc = '<!DOCTYPE html>\n<svg><![CDATA[ <!-- keep --> ]]></svg>\n<script type="application/ld+json">\n{"a": "<!-- x -->"}\n</script>';
        assert.equal(compactPublicPage(doc), doc);
    });

    it('survives a closing tag in any case, and a script that is never closed', () => {
        assert.equal(compactPublicPage('<SCRIPT>a</SCRIPT>\n  <p>x</p>'), '<SCRIPT>a</SCRIPT>\n<p>x</p>');
        assert.equal(compactPublicPage('<script>var a = 1; <!-- x'), '<script>var a = 1; <!-- x');
    });
});

describe('compactCss', () => {
    it('removes comments and indentation, keeps a /*! licence comment', () => {
        assert.equal(compactCss('/* one */\na {\n    /* two */\n    color: red; /* three */\n}\n/*! keep */\n'), 'a{color:red;}\n/*! keep */\n');
    });

    it('leaves a comment marker inside a string or a url() alone', () => {
        const s = 'a{content:"/* no */";background:url("data:image/svg+xml,%3Csvg%3E/*%3C/svg%3E");b:url(data:x/*y);c:\'/* \'}';
        assert.equal(compactCss(s), s);
    });

    it('drops the blanks CSS never reads, and keeps the ones it does', () => {
        assert.equal(compactCss('a ,\n  b  {\n    margin: 0 auto ;\n    color:  red\n}\n'), 'a,b{margin:0 auto;color:red}\n');
        assert.equal(compactCss('.a :hover { x: y }'), '.a :hover{x:y}');
        assert.equal(compactCss('a > :first-child { width: calc(1px + 2px) }'), 'a > :first-child{width:calc(1px + 2px)}');
        assert.equal(compactCss(':root { --x: ; --y: 1 }'), ':root{--x: ;--y:1}');
        assert.equal(compactCss('@media (min-width: 40rem) and (max-width: 60rem) {\n  a { b: c }\n}'), '@media (min-width:40rem) and (max-width:60rem){a{b:c}}');
        assert.equal(compactCss('a{font-family: "A B", c}'), 'a{font-family:"A B",c}');
    });

    it('treats a comment between two words as a separator, as CSS does', () => {
        assert.equal(compactCss('a/**/b{c:d}'), 'a b{c:d}');
        assert.equal(compactCss('a /* x */ b{c:d}'), 'a b{c:d}');
    });

    it('is idempotent', () => {
        const once = compactCss('a {\n  b: c; /* d */\n}\n\n\n.e , .f { g : h }\n');
        assert.equal(compactCss(once), once);
    });
});

// ─── the identity that stays put ─────────────────────────────────────────────────────────────────────────────────────

describe('the mark\'s favicon and the routes that serve the icon set are not touched by L5/L6', () => {
    const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
    it('favicon.svg is the kit\'s 16px micro cut, byte for byte (edited on purpose, in a PR that changes the logo, with this pin)', () => {
        assert.equal(sha('public/favicon.svg'), '3429ef12281c94d8885bc581d801c26fbff94d4669ca3b7fc7993ed3d681e4b0');
    });

    it('src/index.ts serves the four root files a browser asks for by name, from public/, with their own content types', () => {
        const index = read('src/index.ts');
        const routes: Array<[string, string]> = [
            ['favicon.svg', 'image/svg+xml'],
            ['favicon.ico', 'image/x-icon'],
            ['apple-touch-icon.png', 'image/png'],
            ['site.webmanifest', 'application/manifest+json'],
        ];
        for (const [file, type] of routes) {
            const handler = `app.get('/${file}', (_req, res) => {\n    res.type('${type}');\n    res.sendFile(path.join(__dirname, '../public/${file}'), { maxAge: ROOT_ASSET_MAX_AGE });\n});`;
            assert.ok(index.includes(handler), `/${file} is served from public/${file} as ${type}`);
        }
    });

    it('no share card or page names the new «رد» mark: the cards are type only', () => {
        const cards = read('scripts/build-og.mjs');
        assert.equal(/mark-cardamom|mark-micro|<path d="M72 56|plogo-|favicon/.test(cards.replace(/^\s*\*.*$/gm, '')), false, 'the composition draws no mark and no logo');
    });
});
