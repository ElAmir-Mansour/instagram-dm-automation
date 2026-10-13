/**
 * `gatherWebsite` end to end, on the in-memory network: robots.txt, the home page, the pages the navigation points at, the manifest,
 * a stylesheet, and every rule of `safeFetch` applied to every request. No socket is opened.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeNet, html, type FakeNetOptions, type Reply } from './fetchHarness.js';
import { fixture } from './fixtures/load.js';
import { gatherWebsite, mergeSites, MAX_HUB_PAGES, MAX_NAV_PAGES } from './website.js';
import { extractSite } from './siteExtract.js';

const PUBLIC = '93.184.216.34';
const dns = (...hosts: string[]) => Object.fromEntries(hosts.map((h) => [h, [PUBLIC]]));
const page = (name: string, body = ''): Reply => html(name, `<h1>${name}</h1><p>${body || `نص صفحة ${name} كامل وطويل بما يكفي للقراءة`}</p>`);
const css: Reply = { headers: { 'content-type': 'text/css' }, body: fixture('theme.css') };
const manifest: Reply = { headers: { 'content-type': 'application/manifest+json' }, body: fixture('manifest.json') };
const notFound: Reply = { status: 404, headers: { 'content-type': 'text/html' }, body: 'not found' };

/** The store of the Salla fixture, with its pages. */
function storeNet(extra: FakeNetOptions['routes'] = {}, extraDns: Record<string, string[]> = {}) {
    return fakeNet({
        dns: { ...dns('noor-perfumes.example', 'cdn.jsdelivr.net'), ...extraDns },
        routes: {
            'https://noor-perfumes.example/robots.txt': notFound,
            'https://noor-perfumes.example/': { headers: { 'content-type': 'text/html; charset=utf-8' }, body: fixture('salla-store.html') },
            'https://noor-perfumes.example/pages/about-us': page('من نحن'),
            'https://noor-perfumes.example/pages/faq': page('الأسئلة الشائعة'),
            'https://noor-perfumes.example/pages/contact': page('تواصل معنا'),
            'https://noor-perfumes.example/manifest.json': manifest,
            'https://noor-perfumes.example/assets/theme.css?v=3': css,
            ...extra,
        },
    });
}

describe('gatherWebsite: a store', () => {
    it('reads the home page, the three pages the navigation points at, the manifest and the site\'s own stylesheet', async () => {
        const net = storeNet();
        const site = await gatherWebsite('noor-perfumes.example', net);
        assert.equal(site.status, 'ok');
        assert.equal(site.needsPaste, false);
        assert.deepEqual(site.pages.map((p) => [p.role, new URL(p.url).pathname]), [['home', '/'], ['nav', '/pages/about-us'], ['nav', '/pages/faq'], ['nav', '/pages/contact']]);
        assert.equal(site.manifest?.themeColor, '#6B2D5C');
        const fetched = net.calls.map((c) => `${c.url.host}${c.url.pathname}`);
        assert.ok(fetched.includes('noor-perfumes.example/robots.txt'));
        assert.ok(fetched.includes('noor-perfumes.example/manifest.json'));
        assert.ok(fetched.includes('noor-perfumes.example/assets/theme.css'));
        assert.ok(!fetched.some((u) => u.startsWith('cdn.jsdelivr.net')), 'a framework\'s stylesheet from a CDN is not read for the brand');
        assert.ok(!fetched.some((u) => /\.(?:png|jpe?g|webp|gif|ico)$|founder-photo/.test(u)), 'no photograph or raster logo is fetched until a person confirms one');
        assert.ok(fetched.includes('noor-perfumes.example/icons/icon.svg'), 'an SVG logo is read, for its colours only');
        assert.ok(net.calls.every((c) => c.address === PUBLIC));
    });

    it('tries https first and uses it', async () => {
        const net = storeNet();
        await gatherWebsite('noor-perfumes.example', net);
        assert.equal(net.calls[0]!.url.href, 'https://noor-perfumes.example/robots.txt');
        assert.ok(net.calls.every((c) => c.url.protocol === 'https:'));
    });

    it('finds the brand: the page\'s theme-color wins, and the accent comes from the stylesheet', async () => {
        const site = await gatherWebsite('noor-perfumes.example', storeNet());
        assert.equal(site.brand.primary, '#7B3F61');
        assert.equal(site.brand.primarySource, 'theme-color');
        assert.equal(site.brand.accent, '#D9A441');
        assert.match(site.brand.ink, /^#[0-9A-F]{6}$/);
        assert.match(site.brand.paper, /^#[0-9A-F]{6}$/);
        const dark = await gatherWebsite('noor-perfumes.example', { ...storeNet(), theme: 'dark' });
        assert.notEqual(dark.brand.paper, site.brand.paper);
    });

    it('lists logo candidates, never og:image', async () => {
        const site = await gatherWebsite('noor-perfumes.example', storeNet());
        assert.equal(site.logos.candidates[0]!.source, 'jsonld');
        assert.ok(site.logos.candidates.every((c) => !c.url.includes('founder-photo')));
    });

    it('merges what the pages say: socials, contact, the organisation and the offers', async () => {
        const site = await gatherWebsite('noor-perfumes.example', storeNet());
        assert.equal(site.merged.organization?.name, 'متجر نور للعطور');
        assert.equal(site.merged.socials.instagram, 'https://www.instagram.com/noor.perfumes');
        assert.equal(site.merged.whatsapp, 'https://wa.me/966501234567');
        assert.deepEqual(site.merged.emails, ['hello@noor-perfumes.example']);
        assert.deepEqual(site.merged.offers.map((o) => o.price), ['189', '45']);
        assert.equal(site.merged.lang, 'ar');
        assert.equal(site.merged.dir, 'rtl');
    });

    it('keeps each page\'s text within 3000 characters and the whole within 12000', async () => {
        const long = `<p>${'ا'.repeat(6000)}</p>`;
        const net = storeNet({
            'https://noor-perfumes.example/pages/about-us': html('a', long),
            'https://noor-perfumes.example/pages/faq': html('b', long),
            'https://noor-perfumes.example/pages/contact': html('c', long),
            'https://noor-perfumes.example/': { headers: { 'content-type': 'text/html' }, body: fixture('salla-store.html').replace('</main>', `${long}</main>`) },
        });
        const site = await gatherWebsite('noor-perfumes.example', net);
        assert.ok(site.texts.every((t) => Array.from(t.text).length <= 3000));
        assert.ok(site.texts.reduce((n, t) => n + Array.from(t.text).length, 0) <= 12_000);
        assert.equal(site.texts.length, 4);
    });

    it('follows at most four pages', () => {
        assert.equal(MAX_NAV_PAGES, 4);
        assert.equal(MAX_HUB_PAGES, 2);
    });

    it('takes an address as well as a bare name, and an http address is tried over https first', async () => {
        const net = storeNet();
        const site = await gatherWebsite('http://noor-perfumes.example/', net);
        assert.equal(site.status, 'ok');
        assert.equal(net.calls[0]!.url.protocol, 'https:');
    });
});

describe('gatherWebsite: robots.txt', () => {
    it('does not fetch a page the bot is told to stay out of, and says why', async () => {
        const net = storeNet({ 'https://noor-perfumes.example/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: AutoReplyProBot\nDisallow: /pages/faq$\n' } });
        const site = await gatherWebsite('noor-perfumes.example', net);
        assert.equal(site.status, 'ok');
        assert.ok(!site.pages.some((p) => p.url.endsWith('/pages/faq')));
        assert.ok(site.notes.some((n) => n.kind === 'page' && n.error === 'robots' && n.url.endsWith('/pages/faq')));
        assert.ok(!net.calls.some((c) => c.url.pathname === '/pages/faq'));
        assert.equal(site.pages.length, 3);
    });

    it('stops at once when the site is closed to the bot: nothing is fetched but robots.txt', async () => {
        for (const body of ['User-agent: *\nDisallow: /\n', 'User-agent: AutoReplyProBot\nDisallow: /\n']) {
            const net = storeNet({ 'https://noor-perfumes.example/robots.txt': { headers: { 'content-type': 'text/plain' }, body } });
            const site = await gatherWebsite('noor-perfumes.example', net);
            assert.equal(site.status, 'robots');
            assert.deepEqual(site.pages, []);
            assert.deepEqual(net.calls.map((c) => c.url.pathname), ['/robots.txt']);
        }
    });

    it('checks the path the tenant typed, not only the front page', async () => {
        const net = storeNet({ 'https://noor-perfumes.example/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /shop\n' }, 'https://noor-perfumes.example/shop': html('shop') });
        assert.equal((await gatherWebsite('noor-perfumes.example/shop', net)).status, 'robots');
        assert.equal((await gatherWebsite('noor-perfumes.example', storeNet({ 'https://noor-perfumes.example/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /shop\n' } }))).status, 'ok');
    });

    it('reads a missing robots.txt as "no rules" and a server error as "closed", as RFC 9309 says', async () => {
        assert.equal((await gatherWebsite('noor-perfumes.example', storeNet({ 'https://noor-perfumes.example/robots.txt': { status: 403, body: 'x', headers: { 'content-type': 'text/html' } } }))).status, 'ok');
        assert.equal((await gatherWebsite('noor-perfumes.example', storeNet({ 'https://noor-perfumes.example/robots.txt': { headers: { 'content-type': 'text/html' }, body: '<html>soft 404</html>' } }))).status, 'ok');
        const closed = await gatherWebsite('noor-perfumes.example', storeNet({ 'https://noor-perfumes.example/robots.txt': { status: 503, body: 'x', headers: { 'content-type': 'text/html' } } }));
        assert.equal(closed.status, 'robots');
    });

    it('applies the rules to the manifest and the stylesheet of the same site too', async () => {
        const net = storeNet({ 'https://noor-perfumes.example/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /assets/\nDisallow: /manifest.json\n' } });
        const site = await gatherWebsite('noor-perfumes.example', net);
        assert.equal(site.manifest, null);
        assert.ok(!net.calls.some((c) => c.url.pathname.includes('theme.css') || c.url.pathname === '/manifest.json'));
        assert.equal(site.brand.primarySource, 'theme-color', 'the brand still comes from the page itself');
    });
});

describe('gatherWebsite: a site that refuses or is not there', () => {
    it('says "paste your About text" for a firewall\'s 403', async () => {
        const net = storeNet({ 'https://noor-perfumes.example/': { status: 403, headers: { 'content-type': 'text/html' }, body: 'Attention Required! | Cloudflare' } });
        const site = await gatherWebsite('noor-perfumes.example', net);
        assert.equal(site.status, 'blocked');
        assert.equal(site.needsPaste, true);
        assert.deepEqual(site.pages, []);
        assert.ok(site.notes.some((n) => n.kind === 'page' && n.error === 'forbidden' && n.status === 403));
    });

    it('keeps the pages it could read when one of the others refuses', async () => {
        const net = storeNet({ 'https://noor-perfumes.example/pages/faq': { status: 403, headers: { 'content-type': 'text/html' }, body: 'no' } });
        const site = await gatherWebsite('noor-perfumes.example', net);
        assert.equal(site.status, 'ok');
        assert.equal(site.pages.length, 3);
        assert.ok(site.notes.some((n) => n.error === 'forbidden'));
    });

    it('falls back to http when nothing answers on https, and reports unreachable when nothing answers at all', async () => {
        const httpOnly = fakeNet({
            dns: dns('noor-perfumes.example'),
            routes: { 'http://noor-perfumes.example/robots.txt': notFound, 'http://noor-perfumes.example/': { headers: { 'content-type': 'text/html' }, body: '<title>Hi</title><p>مرحبا بكم في متجرنا</p>' } },
        });
        const site = await gatherWebsite('noor-perfumes.example', httpOnly);
        assert.equal(site.status, 'ok');
        assert.deepEqual(httpOnly.calls.map((c) => c.url.protocol), ['https:', 'http:', 'http:']);
        const nothing = await gatherWebsite('gone.example.com', fakeNet({}));
        assert.equal(nothing.status, 'unreachable');
        assert.equal(nothing.needsPaste, false);
        assert.deepEqual(nothing.pages, []);
    });

    it('reports a site that is down as unreachable, with the reason in the notes', async () => {
        const down = await gatherWebsite('down.example.com', fakeNet({ dns: dns('down.example.com') }));
        assert.equal(down.status, 'unreachable');
        assert.ok(down.notes.every((n) => !n.ok));
        assert.ok(down.notes.some((n) => n.error === 'network'));
    });

    it('refuses an address that is not a public site name, and connects to nothing', async () => {
        for (const input of ['127.0.0.1', 'http://169.254.169.254/latest/meta-data/', 'localhost', 'http://[::1]/', 'http://2130706433/', 'user:pw@example.com', 'ftp://example.com', '', '   ', 'metadata.google.internal']) {
            const net = fakeNet({ dns: dns('example.com') });
            const site = await gatherWebsite(input, net);
            assert.equal(site.status, 'unreachable', input);
            assert.equal(net.calls.length, 0, input);
        }
    });

    it('refuses a site whose name resolves to a private address', async () => {
        const net = fakeNet({ dns: { 'sneaky.example.com': ['10.0.0.5'] }, routes: { 'https://sneaky.example.com/robots.txt': notFound, 'https://sneaky.example.com/': page('x') } });
        const site = await gatherWebsite('sneaky.example.com', net);
        assert.equal(site.status, 'unreachable');
        assert.equal(net.calls.length, 0);
        assert.ok(site.notes.every((n) => n.error === 'blocked_address' || n.error === undefined || !n.ok));
    });

    it('stops when the phase is over', async () => {
        const phase = new AbortController();
        phase.abort();
        const net = storeNet();
        const site = await gatherWebsite('noor-perfumes.example', { ...net, signal: phase.signal });
        assert.equal(site.status, 'unreachable');
        assert.equal(net.calls.length, 0);
    });
});

describe('gatherWebsite: a link-in-bio hub', () => {
    const hubNet = (home = fixture('linktree.html'), extra: FakeNetOptions['routes'] = {}, extraDns: Record<string, string[]> = {}) =>
        fakeNet({
            dns: { ...dns('linktr.ee', 'academy.omarfit.example', 'omarfit.example', 'calendly.com'), ...extraDns },
            routes: {
                'https://linktr.ee/robots.txt': notFound,
                'https://linktr.ee/coachomar': { headers: { 'content-type': 'text/html' }, body: home },
                'https://academy.omarfit.example/robots.txt': notFound,
                'https://academy.omarfit.example/12-week-program': page('البرنامج'),
                'https://omarfit.example/robots.txt': notFound,
                'https://omarfit.example/free-workout-guide': page('guide'),
                'https://calendly.com/robots.txt': notFound,
                'https://calendly.com/coachomar/intro-call': page('call'),
                ...extra,
            },
        });

    it('follows at most two of its outbound links, as offer candidates, and reads each host\'s robots.txt first', async () => {
        const net = hubNet();
        const site = await gatherWebsite('https://linktr.ee/coachomar', net);
        assert.equal(site.status, 'ok');
        assert.deepEqual(site.pages.map((p) => [p.role, new URL(p.url).host]), [['home', 'linktr.ee'], ['hub', 'academy.omarfit.example'], ['hub', 'omarfit.example']]);
        const paths = net.calls.map((c) => `${c.url.host}${c.url.pathname}`);
        assert.ok(paths.includes('academy.omarfit.example/robots.txt') && paths.includes('omarfit.example/robots.txt'));
        assert.ok(!paths.some((p) => p.startsWith('calendly.com')), 'the third link is not followed');
        assert.equal(site.merged.socials.instagram, 'https://www.instagram.com/coachomar');
    });

    it('respects the robots.txt of a host it is sent to', async () => {
        const net = hubNet(fixture('linktree.html'), { 'https://academy.omarfit.example/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /\n' } });
        const site = await gatherWebsite('https://linktr.ee/coachomar', net);
        assert.ok(!site.pages.some((p) => p.url.includes('academy.omarfit.example')));
        assert.ok(site.notes.some((n) => n.error === 'robots' && n.url.includes('academy.omarfit.example')));
    });

    it('will not be sent to the inside: a hub whose links go to a metadata address, a private name or a private resolution', async () => {
        const evil = `<title>x</title><ul>
            <li><a href="http://169.254.169.254/latest/meta-data/">a</a></li>
            <li><a href="https://intranet.corp/admin">b</a></li>
            <li><a href="https://sneaky.example.org/x">c</a></li>
            <li><a href="http://127.0.0.1:8080/">d</a></li></ul>`;
        const net = hubNet(evil, { 'https://sneaky.example.org/x': page('SECRET'), 'https://sneaky.example.org/robots.txt': notFound }, { 'sneaky.example.org': ['10.1.1.1'] });
        const site = await gatherWebsite('https://linktr.ee/coachomar', net);
        assert.deepEqual(site.pages.map((p) => p.role), ['home']);
        assert.ok(!net.calls.some((c) => ['169.254.169.254', 'intranet.corp', 'sneaky.example.org', '127.0.0.1'].includes(c.url.hostname)), 'no connection was opened to any of them');
        assert.ok(!JSON.stringify(site).includes('SECRET'));
    });
});

describe('gatherWebsite: whatever the site serves', () => {
    it('survives a site that answers every request with something wrong', async () => {
        const wrong: Reply[] = [
            { headers: { 'content-type': 'application/pdf' }, body: '%PDF' }, { headers: {}, body: 'no type' }, { status: 500 }, { status: 302, headers: {} },
            { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: 'not gzip' }, { headers: { 'content-type': 'text/html' }, body: new Uint8Array(2_000_000).fill(0x61) },
        ];
        for (const reply of wrong) {
            const net = fakeNet({ dns: dns('x.example.com'), routes: { 'https://x.example.com/robots.txt': reply, 'https://x.example.com/': reply } });
            const site = await gatherWebsite('x.example.com', net);
            assert.ok(['ok', 'blocked', 'robots', 'unreachable'].includes(site.status));
            assert.ok(Array.isArray(site.notes));
        }
    });

    it('survives a page that redirects to the inside', async () => {
        const net = fakeNet({
            dns: dns('x.example.com'),
            routes: { 'https://x.example.com/robots.txt': notFound, 'https://x.example.com/': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } } },
        });
        const site = await gatherWebsite('x.example.com', net);
        assert.equal(site.status, 'unreachable');
        assert.ok(site.notes.some((n) => n.kind === 'page' && n.error === 'blocked_url'));
        assert.ok(!net.calls.some((c) => c.url.hostname === '169.254.169.254'));
    });
});

describe('mergeSites', () => {
    it('lets the first page to say something win, and joins lists without repeats', () => {
        const a = extractSite('<html lang="ar"><title>A</title><meta name="description" content="da"><a href="https://www.instagram.com/first">i</a><a href="mailto:a@x.example">m</a>', 'https://x.example/');
        const b = extractSite('<html lang="en" dir="ltr"><title>B</title><a href="https://www.instagram.com/second">i</a><a href="https://x.com/second">x</a><a href="mailto:a@x.example">m</a><a href="mailto:b@x.example">m</a>', 'https://x.example/b');
        const m = mergeSites([a, b]);
        assert.deepEqual([m.title, m.description, m.lang, m.dir], ['A', 'da', 'ar', 'ltr']);
        assert.deepEqual(m.socials, { instagram: 'https://www.instagram.com/first', x: 'https://x.com/second' });
        assert.deepEqual(m.emails, ['a@x.example', 'b@x.example']);
        assert.deepEqual(mergeSites([]).socials, {});
    });
});
