/**
 * The public pages' serve-time template: `{{TOKEN}}` replacement, `data-when` stripping and
 * attribute escaping. `src/index.ts` runs every public page through this on each request, so
 * a wrong answer here is a WhatsApp button that goes nowhere, or a `"` that breaks out of an
 * href — on the one page a prospect sees.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeAttr, pageLangFromQuery, renderSiteTemplate, WHATSAPP_OPENER, whatsappUrl } from './publicPages.js';

const ALL = { whatsappNumber: '966501234567', contactEmail: 'hello@example.com', eidCouponsExpire: '2026-04-05' };
const NONE = { whatsappNumber: null, contactEmail: null, eidCouponsExpire: null };

const PAGE = [
    '<nav>',
    '    <a class="btn" data-when="whatsapp" href="{{WHATSAPP_URL}}">تواصل عبر واتساب</a>',
    '    <a data-when="email" href="mailto:{{CONTACT_EMAIL}}"><bdi dir="ltr">{{CONTACT_EMAIL}}</bdi></a>',
    '    <span>always here</span>',
    '</nav>',
    '<main data-coupons-expire="{{EID_COUPONS_EXPIRE}}">',
    '    <p data-when="eid-expiry">Coupons end on {{EID_COUPONS_EXPIRE}}.</p>',
    '</main>',
].join('\n');

describe('whatsappUrl', () => {
    it('builds a wa.me link with the Arabic opener URL-encoded', () => {
        const url = whatsappUrl('966501234567');
        assert.ok(url.startsWith('https://wa.me/966501234567?text='));
        assert.equal(decodeURIComponent(url.split('text=')[1]!), WHATSAPP_OPENER);
        assert.ok(!/[؀-ۿ]/.test(url), 'no raw Arabic in the URL');
    });

    it('is empty with no number', () => {
        assert.equal(whatsappUrl(null), '');
        assert.equal(whatsappUrl(''), '');
    });
});

describe('renderSiteTemplate', () => {
    it('fills every token when every value is set, and keeps every marked element', () => {
        const out = renderSiteTemplate(PAGE, ALL);
        assert.ok(out.includes(`href="${whatsappUrl(ALL.whatsappNumber).replace(/&/g, '&amp;')}"`));
        assert.ok(out.includes('href="mailto:hello@example.com"'));
        assert.ok(out.includes('<bdi dir="ltr">hello@example.com</bdi>'));
        assert.ok(out.includes('data-coupons-expire="2026-04-05"'));
        assert.ok(out.includes('Coupons end on 2026-04-05.'));
        assert.equal(out.includes('{{'), false, 'no token survives');
        assert.equal((out.match(/data-when=/g) || []).length, 3, 'nothing was stripped');
    });

    it('removes each marked element whose value is empty, and only those', () => {
        const out = renderSiteTemplate(PAGE, { ...ALL, whatsappNumber: null });
        assert.equal(out.includes('data-when="whatsapp"'), false, 'the WhatsApp button is gone');
        assert.equal(out.includes('واتساب'), false, 'with its label');
        assert.ok(out.includes('data-when="email"'), 'the email link stays');
        assert.ok(out.includes('data-when="eid-expiry"'));
        assert.ok(out.includes('<span>always here</span>'), 'unmarked siblings are untouched');
        assert.equal(out.includes('{{'), false);
    });

    it('strips everything marked and blanks every token when nothing is set', () => {
        const out = renderSiteTemplate(PAGE, NONE);
        assert.equal(out.includes('data-when='), false);
        assert.ok(out.includes('data-coupons-expire=""'), 'an unmarked attribute is left empty, which the Eid script treats as inert');
        assert.ok(out.includes('<span>always here</span>'));
        assert.equal(out.includes('{{'), false);
    });

    it('takes the marked element\'s own line with it, so no blank line is left behind', () => {
        const out = renderSiteTemplate(PAGE, NONE);
        assert.equal(out.split('\n').filter((l) => l.trim() === '').length, 0, out);
    });

    it('leaves a marked element that holds a different nested tag intact when its value is set', () => {
        // `<a data-when="email">` wraps a `<bdi>`; the non-greedy match must run to </a>, not
        // stop at the first close it sees.
        const out = renderSiteTemplate(PAGE, ALL);
        assert.ok(out.includes('<a data-when="email" href="mailto:hello@example.com"><bdi dir="ltr">hello@example.com</bdi></a>'));
    });

    it('attribute-escapes every value, so a hostile setting cannot break out of an href', () => {
        const out = renderSiteTemplate(PAGE, {
            whatsappNumber: '1" onclick="x',
            contactEmail: `a"b'c<d>&e@example.com`,
            eidCouponsExpire: '2026-04-05" x="',
        });
        assert.equal(/onclick="x/.test(out), false);
        assert.ok(out.includes('1&quot; onclick=&quot;x'));
        assert.ok(out.includes('a&quot;b&#39;c&lt;d&gt;&amp;e@example.com'));
        assert.ok(out.includes('data-coupons-expire="2026-04-05&quot; x=&quot;"'));
    });

    it('escapeAttr covers the five characters that matter', () => {
        assert.equal(escapeAttr(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
        assert.equal(escapeAttr('plain'), 'plain');
    });

    it('ignores tokens it does not know, so a stray {{X}} in copy stays visible rather than vanishing', () => {
        assert.equal(renderSiteTemplate('<p>{{SOMETHING_ELSE}}</p>', ALL), '<p>{{SOMETHING_ELSE}}</p>');
    });
});

describe('renderSiteTemplate — data-unless, the fallback a data-when element replaces', () => {
    const CTA = [
        '<div>',
        '    <a class="cta" data-when="whatsapp" href="{{WHATSAPP_URL}}">اطلب عرض سعر</a>',
        '    <a class="cta" data-unless="whatsapp" href="#contact-ar">اطلب عرض سعر</a>',
        '</div>',
    ].join('\n');

    it('keeps the WhatsApp CTA and drops the fallback when a number is set', () => {
        const out = renderSiteTemplate(CTA, ALL);
        assert.ok(out.includes('data-when="whatsapp"'));
        assert.equal(out.includes('data-unless'), false);
        assert.equal((out.match(/class="cta"/g) || []).length, 1, 'exactly one CTA');
    });

    it('keeps the fallback and drops the WhatsApp CTA when there is no number', () => {
        const out = renderSiteTemplate(CTA, NONE);
        assert.equal(out.includes('data-when'), false);
        assert.ok(out.includes('href="#contact-ar"'));
        assert.equal((out.match(/class="cta"/g) || []).length, 1, 'exactly one CTA');
    });
});

describe('renderSiteTemplate — the language of the served page', () => {
    const HEAD = [
        '<html lang="ar" dir="rtl">',
        '<head>',
        '    <meta name="description" data-lang-only="ar" content="وصف عربي">',
        '    <meta name="description" data-lang-only="en" content="English description">',
        '    <link rel="canonical" href="https://example.com/pricing{{LANG_QUERY}}">',
        '    <link rel="alternate" hreflang="en" href="https://example.com/pricing?lang=en">',
        '</head>',
    ].join('\n');

    it('serves Arabic by default: the Arabic description only, and a bare canonical', () => {
        const out = renderSiteTemplate(HEAD, ALL);
        assert.ok(out.startsWith('<html lang="ar" dir="rtl">'));
        assert.ok(out.includes('content="وصف عربي"'));
        assert.equal(out.includes('English description'), false);
        assert.ok(out.includes('href="https://example.com/pricing"'));
        assert.equal(out.includes('data-lang-only="ar"'), true, 'the kept line is untouched');
        assert.equal(out.split('\n').filter((l) => l.trim() === '').length, 0, 'no blank line left behind');
    });

    it('serves the ?lang=en alternate with its own description, direction and canonical', () => {
        const out = renderSiteTemplate(HEAD, ALL, 'en');
        assert.ok(out.startsWith('<html lang="en" dir="ltr">'));
        assert.ok(out.includes('content="English description"'));
        assert.equal(out.includes('وصف عربي'), false);
        assert.ok(out.includes('href="https://example.com/pricing?lang=en"'));
    });

    it('reads only an exact ?lang=en as English', () => {
        assert.equal(pageLangFromQuery('en'), 'en');
        for (const v of [undefined, '', 'ar', 'EN', 'fr', ['en'], 1]) assert.equal(pageLangFromQuery(v), 'ar', String(v));
    });
});
