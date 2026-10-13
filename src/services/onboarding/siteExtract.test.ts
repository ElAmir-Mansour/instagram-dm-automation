/**
 * The site extractor on fixtures: a Salla-style Arabic store, a Linktree-style hub, a WordPress page with an
 * FAQPage, a page with hidden injection text and a page with malformed JSON-LD. The fixtures are written by
 * hand in the shape of those sites; none is a capture of a real one.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixture } from './fixtures/load.js';
import { capSiteTexts, extractSite, hubCandidates, isHiddenElement, languageOfText, navCandidates, pickStylesheets, resolveHref, PAGE_TEXT_CHARS, TOTAL_TEXT_CHARS } from './siteExtract.js';
import { classifySocialUrl, isLinkHubHost, whatsappFrom } from './socials.js';

const STORE = 'https://noor-perfumes.example/';

describe('extractSite: an Arabic store', () => {
    const site = extractSite(fixture('salla-store.html'), STORE);

    it('reads the head', () => {
        assert.equal(site.title, 'متجر نور للعطور | عطور شرقية وغربية أصلية');
        assert.match(site.description, /^متجر نور للعطور: عطور أصلية/);
        assert.equal(site.canonical, STORE);
        assert.equal(site.lang, 'ar', 'ar-SA reads as ar');
        assert.equal(site.dir, 'rtl');
        assert.equal(site.textLang, 'ar');
        assert.equal(site.og['og:title'], 'متجر نور للعطور');
        assert.equal(site.og['twitter:card'], 'summary_large_image');
    });

    it('takes the light theme-color, not the one for dark mode', () => {
        assert.equal(site.themeColor, '#7B3F61');
    });

    it('lists icons, the manifest and the stylesheets as absolute addresses, print sheets left out', () => {
        assert.equal(site.manifestUrl, 'https://noor-perfumes.example/manifest.json');
        assert.deepEqual(site.icons.map((i) => [i.rel, i.size, i.href]), [
            ['icon', 32, 'https://noor-perfumes.example/favicon-32.png'],
            ['icon', 192, 'https://noor-perfumes.example/icon-192.png'],
            ['icon', 0, 'https://noor-perfumes.example/favicon.ico'],
            ['apple-touch-icon', 180, 'https://noor-perfumes.example/apple-touch-icon.png'],
        ]);
        assert.equal(site.stylesheets.length, 2);
        assert.ok(!site.stylesheets.some((s) => s.includes('print.css')));
        assert.equal(site.inlineStyles.length, 1);
    });

    it('reads the JSON-LD: the organisation, two products with prices', () => {
        const org = site.jsonLd.organization!;
        assert.equal(org.name, 'متجر نور للعطور');
        assert.deepEqual(org.logos, ['https://noor-perfumes.example/assets/logo-512.png']);
        assert.equal(org.email, 'hello@noor-perfumes.example');
        assert.equal(org.telephone, '+966 11 234 5678');
        assert.deepEqual(site.jsonLd.offers.map((o) => [o.kind, o.name, o.price, o.currency]), [
            ['product', 'عود الليل - ٥٠ مل', '189', 'SAR'],
            ['product', 'بخور الشام', '45', 'SAR'],
        ]);
        assert.equal(site.jsonLd.offers[0]!.url, 'https://noor-perfumes.example/products/oud-alleil');
        assert.equal(site.jsonLd.invalid, 0);
    });

    it('finds the creator\'s own social accounts and not a share button, a post or an intent', () => {
        assert.deepEqual(site.socials.links, {
            instagram: 'https://www.instagram.com/noor.perfumes',
            tiktok: 'https://www.tiktok.com/@noor.perfumes',
            x: 'https://x.com/noorperfumes',
            youtube: 'https://www.youtube.com/@noorperfumes',
        });
        assert.equal(site.socials.handles.instagram, 'noor.perfumes');
        assert.ok(!('facebook' in site.socials.links), 'a sharer link is not a Facebook page');
    });

    it('finds the contact details: email, phone, and WhatsApp as a wa.me link', () => {
        assert.deepEqual(site.contact.emails, ['hello@noor-perfumes.example']);
        assert.deepEqual(site.contact.phones, ['+966112345678']);
        assert.equal(site.contact.whatsapp, 'https://wa.me/966501234567');
    });

    it('takes headings, list items and the text a visitor reads, without the menu, the footer or the hidden banner', () => {
        assert.deepEqual(site.headings, ['عطور تشبهك، من قلب الرياض', 'الأكثر مبيعاً']);
        assert.deepEqual(site.listItems, ['عود الليل - ٥٠ مل: ١٨٩ ريال', 'بخور الشام: ٤٥ ريال', 'شحن مجاني للطلبات فوق ٣٠٠ ريال']);
        assert.match(site.text, /عطور تشبهك، من قلب الرياض/);
        assert.match(site.text, /راح نساعدك تختار الأنسب/);
        assert.doesNotMatch(site.text, /خصم ٩٠٪/, 'display:none text is not read');
        assert.doesNotMatch(site.text, /الرئيسية|الأسئلة الشائعة/, 'the menu is not voice');
        assert.doesNotMatch(site.text, /©|واتساب/, 'the footer is not voice');
        assert.equal(site.hiddenBlocks, 1);
    });

    it('picks the pages worth reading from the navigation: about, FAQ, contact; not a workshop, not a PDF', () => {
        const pages = navCandidates(site);
        assert.deepEqual(pages.map((p) => p.href), [
            'https://noor-perfumes.example/pages/about-us',
            'https://noor-perfumes.example/pages/faq',
            'https://noor-perfumes.example/pages/contact',
        ]);
        assert.ok(pages.every((p) => p.inNav));
    });

    it('prefers the site\'s own stylesheet over a framework\'s from a CDN', () => {
        assert.deepEqual(pickStylesheets(site), ['https://noor-perfumes.example/assets/theme.css?v=3']);
    });
});

describe('extractSite: a link-in-bio hub', () => {
    const hub = extractSite(fixture('linktree.html'), 'https://linktr.ee/coachomar');

    it('knows it is a hub, and offers its outbound links as offer candidates', () => {
        assert.equal(hub.hub, true);
        assert.deepEqual(hubCandidates(hub).map((l) => l.href), [
            'https://academy.omarfit.example/12-week-program',
            'https://omarfit.example/free-workout-guide',
            'https://calendly.com/coachomar/intro-call',
        ]);
        assert.deepEqual(hubCandidates(hub, 2).length, 2);
    });

    it('keeps the profile, the socials and the contact out of the offers', () => {
        assert.equal(hub.socials.links.instagram, 'https://www.instagram.com/coachomar');
        assert.equal(hub.socials.links.youtube, 'https://www.youtube.com/@coachomar');
        assert.equal(hub.contact.whatsapp, 'https://wa.me/447700900123');
        assert.deepEqual(hub.contact.emails, ['omar@omarfit.example']);
        assert.match(hub.text, /Strength coach/);
    });

    it('is not a hub when the same page is on another host', () => {
        assert.equal(extractSite(fixture('linktree.html'), 'https://omarfit.example/links').hub, false);
        assert.equal(isLinkHubHost('linktr.ee'), true);
        assert.equal(isLinkHubHost('www.beacons.ai'), true);
        assert.equal(isLinkHubHost('bio.link'), true);
        assert.equal(isLinkHubHost('notlinktr.ee'), false);
    });
});

describe('extractSite: a WordPress page with an FAQPage', () => {
    const wp = extractSite(fixture('wordpress-faq.html'), 'https://brightleaf.example/');

    it('reads the FAQ with the markup taken out of the answers', () => {
        assert.deepEqual(wp.jsonLd.faq, [
            { question: 'Do I need any previous Spanish?', answer: 'No. The A1 course starts from zero.' },
            { question: 'How long is each class?', answer: 'Each class is 60 minutes, twice a week.' },
            { question: 'Can I get a refund?', answer: 'Yes, within 14 days of the first class. See https://brightleaf.example/refunds/ for details.' },
        ]);
    });

    it('reads a Course as an offer with its price, and the organisation from a @graph', () => {
        assert.deepEqual(wp.jsonLd.offers.map((o) => [o.kind, o.name, o.price, o.currency]), [['course', 'Spanish for Beginners (A1)', '249.00', 'GBP']]);
        assert.equal(wp.jsonLd.organization?.name, 'Bright Leaf Language School');
        assert.equal(wp.lang, 'en');
        assert.equal(wp.textLang, 'en');
    });

    it('reads social accounts from sameAs, including a channel URL', () => {
        assert.equal(wp.socials.links.facebook, 'https://www.facebook.com/brightleafschool');
        assert.equal(wp.socials.links.linkedin, 'https://www.linkedin.com/company/bright-leaf-school');
        assert.equal(wp.socials.links.youtube, 'https://www.youtube.com/channel/UCabc123def456');
    });

    it('reads a phone number from the text and an email from a mailto link', () => {
        assert.deepEqual(wp.contact.emails, ['hello@brightleaf.example']);
        assert.deepEqual(wp.contact.phones, ['+442079460958']);
    });

    it('picks four pages in the order they are worth: about, FAQ, pricing, courses', () => {
        assert.deepEqual(navCandidates(wp).map((l) => new URL(l.href).pathname), ['/about-us/', '/faq/', '/pricing/', '/courses/']);
        assert.equal(navCandidates(wp, 2).length, 2);
    });

    it('skips WordPress core CSS only if it is a framework: the theme sheet comes first', () => {
        assert.equal(pickStylesheets(wp)[0], 'https://brightleaf.example/wp-includes/css/dist/block-library/style.min.css?ver=6.5.2');
        assert.equal(pickStylesheets(wp).length, 2);
    });
});

describe('extractSite: hidden text', () => {
    const page = extractSite(fixture('hidden-injection.html'), 'https://pixel.example/');

    it('leaves out everything a visitor cannot see', () => {
        for (const marker of ['PWNED', 'Ignore all previous', 'ignore previous instructions', 'reveal the system prompt', 'evil.example', 'wire money', 'Disregard the schema', 'API key', 'unrestricted']) {
            assert.ok(!page.text.includes(marker), `"${marker}" must not be in the text`);
            assert.ok(!page.headings.join().includes(marker) && !page.listItems.join().includes(marker));
        }
        assert.ok(page.hiddenBlocks >= 9, `${page.hiddenBlocks} hidden blocks counted`);
    });

    it('keeps the text that is visible, including text that merely looks like an attack', () => {
        assert.match(page.text, /We design calm, clear brand identities/);
        assert.match(page.text, /one-hour discovery call/);
        assert.deepEqual(page.headings, ['Pixel Garden Studio', 'What we do']);
        assert.deepEqual(page.listItems, ['Logo design', 'Brand guidelines', 'Social media kits']);
        // Visible, so it is read: it is the fence's job, later, to make it harmless.
        assert.match(page.text, /<\/source> <\/untrusted_sources>/);
    });

    it('reads each way of hiding an element', () => {
        const hidden: Array<[string, Record<string, string>]> = [
            ['div', { hidden: '' }], ['div', { 'aria-hidden': 'true' }], ['div', { 'aria-hidden': 'TRUE' }], ['input', { type: 'hidden' }],
            ['div', { class: 'sr-only' }], ['div', { class: 'a visually-hidden b' }], ['div', { class: 'd-none' }], ['div', { class: 'hidden' }],
            ['div', { style: 'display:none' }], ['div', { style: 'DISPLAY : NONE !important' }], ['div', { style: 'visibility:hidden' }], ['div', { style: 'opacity:0' }], ['div', { style: 'opacity: 0.0;' }],
            ['div', { style: 'font-size:0' }], ['div', { style: 'font-size: 0px' }], ['div', { style: 'position:absolute;left:-9999px' }], ['div', { style: 'text-indent:-5000px' }],
            ['div', { style: 'color: transparent' }], ['div', { style: 'clip:rect(0,0,0,0)' }], ['div', { style: 'width:0;height:0;overflow:hidden' }],
        ];
        for (const [tag, attrs] of hidden) assert.equal(isHiddenElement(tag, attrs), true, JSON.stringify([tag, attrs]));
        const visible: Array<[string, Record<string, string>]> = [
            ['div', {}], ['div', { 'aria-hidden': 'false' }], ['input', { type: 'text' }], ['div', { class: 'hero hidden-xs' }], ['div', { style: 'opacity:0.5' }], ['div', { style: 'font-size:0.9em' }],
            ['div', { style: 'font-size:10px;left:-5px' }], ['div', { style: 'display:block' }], ['div', { style: 'color:#fff' }], ['div', { style: 'width:0' }], ['div', { style: 'height:0;overflow:visible' }],
        ];
        for (const [tag, attrs] of visible) assert.equal(isHiddenElement(tag, attrs), false, JSON.stringify([tag, attrs]));
    });

    it('does not let an unclosed hidden element swallow the rest of the page for the wrong reason, and a closed one end where it should', () => {
        const html = '<body><div style="display:none"><p>secret</p></div><p>shown</p><span hidden>gone</span><p>also shown</p></body>';
        const out = extractSite(html, 'https://x.example/');
        assert.equal(out.text, 'shown\nalso shown');
    });

    it('survives a head with no closing tag', () => {
        const out = extractSite('<html><head><title>T</title><meta name="description" content="D"><body><p>Body text here</p></body></html>', 'https://x.example/');
        assert.equal(out.title, 'T');
        assert.equal(out.description, 'D');
        assert.equal(out.text, 'Body text here');
    });
});

describe('extractSite: malformed JSON-LD', () => {
    const page = extractSite(fixture('malformed-jsonld.html'), 'https://amal-school.example/');

    it('does not throw, counts what it could not read, and keeps what it could', () => {
        assert.equal(page.jsonLd.invalid, 2);
        assert.equal(page.jsonLd.organization?.name, 'مدرسة الأمل');
        assert.equal(page.jsonLd.organization?.url, 'https://amal-school.example/');
        assert.deepEqual(page.jsonLd.organization?.logos, ['https://amal-school.example/logo.png']);
        assert.deepEqual(page.jsonLd.offers, []);
        assert.deepEqual(page.jsonLd.faq, []);
    });

    it('repairs a literal line break inside a string', () => {
        assert.equal(page.jsonLd.organization?.description, 'حلقات قرآن عن بعد للأطفال والكبار');
    });

    it('still reads the rest of the page', () => {
        assert.equal(page.title, 'مدرسة الأمل لتعليم القرآن');
        assert.equal(page.lang, 'ar');
        assert.match(page.text, /نعلّم القرآن الكريم عن بعد/);
    });

    it('survives JSON-LD of every wrong shape', () => {
        const shapes = ['{}', '[]', 'null', '1', '"s"', '{"@type": 5}', '{"@type": ["Organization", null], "name": {"x": 1}}', '{"@graph": 7}', `{"@type":"Product","offers":[1,2,{"price":{"a":1}}],"name":"X"}`, '{"@type":"FAQPage","mainEntity":[{"@type":"Question"}]}', `{"@type":"Organization","sameAs":[1,{"a":1},"javascript:alert(1)"],"logo":[null,5,{"url":"data:image/png;base64,AAAA"}]}`];
        for (const shape of shapes) {
            const html = `<script type="application/ld+json">${shape}</script><p>x</p>`;
            assert.doesNotThrow(() => extractSite(html, 'https://x.example/'), shape);
        }
        const odd = extractSite(`<script type="application/ld+json">{"@type":"Organization","name":"N","sameAs":[1,"javascript:alert(1)"],"logo":[null,{"url":"data:image/png;base64,AAAA"}]}</script>`, 'https://x.example/');
        assert.deepEqual(odd.jsonLd.organization?.sameAs, []);
        assert.deepEqual(odd.jsonLd.organization?.logos, []);
    });

    it('reads a deeply nested graph without running away', () => {
        let nested = '{"@type":"Thing"}';
        for (let i = 0; i < 5000; i++) nested = `{"@type":"Thing","x":${nested}}`;
        const started = Date.now();
        assert.doesNotThrow(() => extractSite(`<script type="application/ld+json">${nested}</script>`, 'https://x.example/'));
        assert.ok(Date.now() - started < 2000);
    });
});

describe('extractSite: text and caps', () => {
    it('cuts the visible text at 3000 characters by default, at a line, and never splits a character', () => {
        const long = Array.from({ length: 400 }, (_, i) => `<p>سطر رقم ${i} 😀 مع بعض الكلمات الإضافية</p>`).join('');
        const site = extractSite(`<body>${long}</body>`, 'https://x.example/');
        assert.ok(Array.from(site.text).length <= PAGE_TEXT_CHARS, `${Array.from(site.text).length}`);
        assert.ok(!/[\uD800-\uDBFF]$/.test(site.text) && !/^[\uDC00-\uDFFF]/.test(site.text));
        assert.equal(Array.from(extractSite(`<body>${long}</body>`, 'https://x.example/', { maxChars: 100 }).text).length <= 100, true);
    });

    it('drops lines that repeat, and lines of one character', () => {
        const site = extractSite('<body><p>Menu</p><p>Real text</p><p>Menu</p><p>x</p><p>Real text</p></body>', 'https://x.example/');
        assert.equal(site.text, 'Menu\nReal text');
    });

    it('budgets pages: 3000 each and 12000 in all', () => {
        const pages = Array.from({ length: 8 }, (_, i) => ({ url: `https://x.example/${i}`, text: 'ا'.repeat(5000) }));
        const capped = capSiteTexts(pages);
        assert.ok(capped.every((p) => Array.from(p.text).length <= PAGE_TEXT_CHARS));
        assert.equal(capped.reduce((n, p) => n + Array.from(p.text).length, 0), TOTAL_TEXT_CHARS);
        assert.equal(capped.length, 4);
        assert.deepEqual(capSiteTexts([{ url: 'a', text: '  ' }, { url: 'b', text: 'x' }]), [{ url: 'b', text: 'x' }]);
    });

    it('guesses the language of a text by its letters', () => {
        assert.equal(languageOfText('هذا نص عربي طويل بما يكفي لنعرف لغته بالتأكيد'), 'ar');
        assert.equal(languageOfText('This is a long enough English sentence to be sure'), 'en');
        assert.equal(languageOfText('This is English and هذا نص عربي بنفس الطول تقريباً and more English here'), 'mixed');
        assert.equal(languageOfText('short'), null);
        assert.equal(languageOfText('1234567890 !!!! 1234567890'), null);
    });

    it('resolves a relative address against the page, keeps http and https, and refuses everything else', () => {
        const base = new URL('https://x.example/a/b');
        assert.equal(resolveHref('../c?d=1#e', base), 'https://x.example/c?d=1');
        assert.equal(resolveHref('//cdn.example/x.css', base), 'https://cdn.example/x.css');
        assert.equal(resolveHref('javascript:alert(1)', base), null);
        assert.equal(resolveHref('data:text/html,hi', base), null);
        assert.equal(resolveHref('mailto:a@b.example', base), null);
        assert.equal(resolveHref('#top', base), null);
        assert.equal(resolveHref('', base), null);
        assert.equal(resolveHref(undefined, base), null);
    });

    it('honours a <base href> for the addresses after it', () => {
        const site = extractSite('<head><base href="https://cdn.example/root/"><link rel="stylesheet" href="s.css"></head>', 'https://x.example/');
        assert.deepEqual(site.stylesheets, ['https://cdn.example/root/s.css']);
    });

    it('never throws, whatever it is given', () => {
        for (const html of ['', ' ', '<', 'plain text', '\u0000\u0001', '<html', '<a href=>', '<svg><svg><svg>', '<a><a><a>text</a>', '</div></div>', '<div>'.repeat(5000), '<li><li><li>x']) {
            assert.doesNotThrow(() => extractSite(html, 'https://x.example/'), JSON.stringify(html.slice(0, 20)));
        }
        assert.doesNotThrow(() => extractSite('<p>x</p>', 'not a url'));
    });

    it('collects the colours written on inline SVG', () => {
        const site = extractSite('<body><svg><path fill="#2E7D6B"/><circle fill="none"/><stop stop-color="rgb(10,20,30)"/></svg></body>', 'https://x.example/');
        assert.deepEqual(site.svgFills, ['#2E7D6B', 'rgb(10,20,30)']);
    });
});

describe('contact details', () => {
    it('does not take an image file name for an email, nor a placeholder', () => {
        const site = extractSite('<body><p>logo@2x.png and you@example.com and real@brand.example</p></body>', 'https://x.example/');
        assert.deepEqual(site.contact.emails, ['real@brand.example']);
    });

    it('takes an international number from the text, and not a price or a date', () => {
        const site = extractSite('<body><p>Call +971 4 123 4567 now. Price 199.99. Date 2026-10-14. Order 12345.</p></body>', 'https://x.example/');
        assert.deepEqual(site.contact.phones, ['+97141234567']);
    });

    it('does not read a run of round numbers as a phone number', () => {
        const site = extractSite('<body><p>Over 1000 2000 3000 followers, 100 200 300 clients, 10000 20000 words.</p></body>', 'https://x.example/');
        assert.deepEqual(site.contact.phones, []);
    });

    it('reads 00-prefixed and tel: numbers, once each', () => {
        const site = extractSite('<body><a href="tel:+966501234567">call</a><p>00966 50 123 4567</p></body>', 'https://x.example/');
        assert.deepEqual(site.contact.phones, ['+966501234567']);
    });

    it('reads WhatsApp in its four spellings', () => {
        assert.equal(whatsappFrom('https://wa.me/966501234567'), 'https://wa.me/966501234567');
        assert.equal(whatsappFrom('https://wa.me/+966 50 123 4567'), 'https://wa.me/966501234567');
        assert.equal(whatsappFrom('https://api.whatsapp.com/send?phone=966501234567&text=hi'), 'https://wa.me/966501234567');
        assert.equal(whatsappFrom('whatsapp://send?phone=966501234567'), 'https://wa.me/966501234567');
        assert.equal(whatsappFrom('https://wa.me/message/ABCDEF123456'), 'https://wa.me/message/ABCDEF123456');
        assert.equal(whatsappFrom('https://wa.me/12'), null);
        assert.equal(whatsappFrom('https://example.com/966501234567'), null);
        assert.equal(whatsappFrom('not a url'), null);
    });
});

describe('classifySocialUrl', () => {
    const cases: Array<[string, string | null]> = [
        ['https://instagram.com/noor.perfumes/', 'instagram:noor.perfumes'], ['http://www.instagram.com/noor_perfumes?hl=ar', 'instagram:noor_perfumes'],
        ['https://www.instagram.com/p/Cx123/', null], ['https://www.instagram.com/reel/Cx123/', null], ['https://www.instagram.com/explore/tags/x/', null], ['https://www.instagram.com/', null],
        ['https://www.youtube.com/@MyChannel', 'youtube:MyChannel'], ['https://youtube.com/channel/UCabc123', 'youtube:UCabc123'], ['https://www.youtube.com/c/MyName', 'youtube:MyName'],
        ['https://www.youtube.com/watch?v=abc', null], ['https://www.youtube.com/shorts/abc', null], ['https://youtu.be/abc', null], ['https://www.youtube.com/@a', null],
        ['https://www.linkedin.com/in/some-person/', 'linkedin:some-person'], ['https://linkedin.com/company/acme', 'linkedin:acme'], ['https://www.linkedin.com/feed/', null], ['https://www.linkedin.com/shareArticle?url=x', null],
        ['https://twitter.com/someone', 'x:someone'], ['https://x.com/someone/status/123', 'x:someone'], ['https://twitter.com/intent/tweet?text=x', null], ['https://x.com/share', null], ['https://x.com/i/flow/login', null], ['https://x.com/toolongahandlefortwitter', null],
        ['https://www.tiktok.com/@some.one', 'tiktok:some.one'], ['https://www.tiktok.com/@some.one/video/123', 'tiktok:some.one'], ['https://www.tiktok.com/discover', null],
        ['https://www.facebook.com/somepage', 'facebook:somepage'], ['https://m.facebook.com/some.page/', 'facebook:some.page'], ['https://www.facebook.com/sharer/sharer.php?u=x', null], ['https://www.facebook.com/sharer.php?u=x', null],
        ['https://www.facebook.com/dialog/share', null], ['https://www.facebook.com/profile.php?id=123', null], ['https://www.facebook.com/plugins/like.php', null], ['https://fb.com/somepage', 'facebook:somepage'],
        ['https://github.com/someone', 'github:someone'], ['https://github.com/someone/repo', 'github:someone'], ['https://github.com/features', null], ['https://github.com/login', null],
        ['https://example.com/instagram.com/x', null], ['https://instagram.com.evil.example/x', null], ['https://notinstagram.com/x', null], ['ftp://instagram.com/x', null], ['mailto:a@b.example', null], ['not a url', null],
    ];
    for (const [url, expected] of cases) {
        it(`${url} is ${expected ?? 'not a profile'}`, () => {
            const social = classifySocialUrl(url);
            assert.equal(social ? `${social.platform}:${social.handle}` : null, expected);
            if (social) assert.match(social.url, /^https:\/\/[^?#]+[^/]$/, 'canonical: https, no query, no trailing slash');
        });
    }
});
