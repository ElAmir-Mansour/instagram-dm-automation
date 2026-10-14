/**
 * What the sales bot may not say (`guard.ts`): a link it wrote, a woman in an emoji, a price that is not live, a number or a discount
 * the owner's data does not hold. The tables are Arabic first (digits in both scripts, the dialects' currency words) and English.
 *
 * The cases that carry the weight are the ones where a LOOSER check would pass: «السعر 49 ريال» when 49 is the lesson count in the
 * data and the live price is 349. The mutation that breaks `isLive` in `guard.ts` is caught by exactly those.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkClaims, guardReply, linkKey, stripLinks, stripWomenEmoji, type ClaimFacts, type Violation } from './guard.js';
import type { LivePrice } from './price.js';

const LIVE_349: LivePrice = { offerId: 'a', text: '349 SAR', amounts: ['349'], currency: 'SAR', validUntil: '2026-12-31' };

/** The data the model was shown: counts, a rating, hours; and one live price. 49 is a LESSON COUNT, not a price. */
const FACTS: ClaimFacts = {
    texts: [
        'العرض فيه 49 درساً و12 مشروعاً. نرد من الساعة 09:00 إلى 17:00. التقييم 4.7 من 1,200 طالب.',
        'The program has 8 modules over 3 months.',
    ],
    prices: [LIVE_349],
};

const kinds = (vs: Violation[]): string[] => vs.map((v) => v.kind);

describe('guardReply: what passes', () => {
    const fine: [string, string][] = [
        ['the live price, in words and digits', 'السعر 349 ريال'],
        ['the live price, in Arabic-Indic digits', 'السعر ٣٤٩ ريال سعودي'],
        ['the live price, in the currency\'s code', 'it is 349 SAR today'],
        ['the live price, with an abbreviation', 'السعر ٣٤٩ ر.س'],
        ['the live price, after the price word alone', 'السعر الحالي 349'],
        ['a count from the data', 'فيه 49 درس و12 مشروع'],
        ['a count from the data, in the other script', 'فيه ٤٩ درس و١٢ مشروع'],
        ['a rating with its decimal mark', 'التقييم ٤٫٧ من ١٬٢٠٠ طالب'],
        ['hours as the data writes them', 'نرد من 09:00 إلى 17:00'],
        ['hours with the leading zero dropped', 'نرد من 9:00 إلى 17:00'],
        ['a number from the English data', 'It has 8 modules over 3 months'],
        ['a price word with a count after it', 'السعر يشمل 12 مشروع'],
        ['an ordinary "free"', 'feel free to ask me anything'],
        ['a reply with no number at all', 'هلا! وش المستوى اللي تبيه تبدأ منه؟'],
        ['a list marker', '1. ابدأ بالأساسيات\n2. ثم المشروع'],
        ['a keycap emoji', '1️⃣ ابدأ بالأساسيات'],
    ];
    for (const [what, text] of fine) {
        it(`${what}: ${text}`, () => {
            const g = guardReply(text, FACTS);
            assert.deepEqual(g.violations, [], text);
            assert.equal(g.ok, true);
        });
    }
});

describe('guardReply: a price that is not live is refused even when its number is in the data', () => {
    // The first column is what a looser guard would call fine: every number here is in `FACTS.texts` (49) or is the live amount.
    const wrong: [string, string][] = [
        ['49 is the lesson count, not the price', 'السعر 49 ريال'],
        ['the same in Arabic-Indic digits', 'السعر ٤٩ ريال'],
        ['the amount is live but the currency is not', '349 USD'],
        ['the amount is live but the symbol is another currency', 'it costs $349'],
        ['the amount is live but the word is another currency', 'السعر 349 دولار'],
        ['a price a little off', 'السعر 350 ريال'],
        ['a price a lot off, with the price word alone', 'السعر 340'],
        ['a price in the other direction', 'it costs 3490 SAR'],
        ['a price after the currency', 'SAR 49'],
        ['a price in a bare symbol', '$49'],
        ['a price in words', 'السعر خمسين دولار'],
        ['a price in English words', 'it is fifty dollars'],
        ['a rounded live price', 'تقريباً 350 ريال'],
    ];
    for (const [what, text] of wrong) {
        it(`${what}: ${text}`, () => {
            const g = guardReply(text, FACTS);
            assert.ok(kinds(g.violations).includes('price'), `${text} → ${JSON.stringify(g.violations)}`);
            assert.equal(g.ok, false);
        });
    }

    it('says what it found', () => {
        assert.deepEqual(guardReply('السعر 49 ريال', FACTS).violations, [{ kind: 'price', found: '49 ريال' }]);
        assert.deepEqual(guardReply('it costs $349', FACTS).violations, [{ kind: 'price', found: '$ 349' }]);
    });

    it('with no live price at all, any amount of money is refused, and a price sitting in the knowledge base does not make it sayable', () => {
        const dated: ClaimFacts = { texts: ['البرنامج بـ 49 دولار'], prices: [] };
        assert.deepEqual(kinds(guardReply('البرنامج 49 دولار', dated).violations), ['price']);
        assert.deepEqual(kinds(guardReply('the price is 49 dollars', { texts: ['the program costs 49 dollars'], prices: [] }).violations), ['price']);
        // …but its number is a number: «49 درس» is still fine.
        assert.deepEqual(guardReply('فيه 49 درس', dated).violations, []);
    });

    it('a live price whose text names no currency accepts any currency word: the owner left it open', () => {
        const open: ClaimFacts = { texts: [], prices: [{ offerId: 'a', text: '349', amounts: ['349'], currency: null, validUntil: '2026-12-31' }] };
        assert.deepEqual(guardReply('349 ريال', open).violations, []);
        assert.deepEqual(guardReply('349 دولار', open).violations, []);
        assert.deepEqual(kinds(guardReply('350 دولار', open).violations), ['price']);
    });

    it('a live price in a currency whose word names several countries (ريال) accepts any of them', () => {
        const qar: ClaimFacts = { texts: [], prices: [{ offerId: 'a', text: '349 QAR', amounts: ['349'], currency: 'QAR', validUntil: '2026-12-31' }] };
        assert.deepEqual(guardReply('349 ريال', qar).violations, []);
        assert.deepEqual(kinds(guardReply('349 درهم', qar).violations), ['price']);
    });

    it('a price with several amounts (a range) allows each of them', () => {
        const range: ClaimFacts = { texts: [], prices: [{ offerId: 'a', text: '199 - 249 USD', amounts: ['199', '249'], currency: 'USD', validUntil: '2026-12-31' }] };
        assert.deepEqual(guardReply('من 199 إلى 249 دولار', range).violations, []);
        assert.deepEqual(kinds(guardReply('من 199 إلى 299 دولار', range).violations), ['price']);
    });
});

describe('guardReply: a number the data does not hold', () => {
    const invented: [string, string, string][] = [
        ['a student count', 'عندنا 5000 طالب', '5000'],
        ['the same in Arabic-Indic digits', 'عندنا ٥٠٠٠ طالب', '5000'],
        ['a percentage', '٩٠٪ من الطلاب يوصون به', '90'],
        ['a rating that was not given', 'التقييم 4.9', '4.9'],
        ['a year', 'منذ 2019 ونحن نعمل', '2019'],
        ['hours that are not the owner\'s', 'نرد من 06:00', '6'],
        ['a count in English', 'It has 7 modules', '7'],
    ];
    for (const [what, text, found] of invented) {
        it(`${what}: ${text}`, () => {
            const g = guardReply(text, FACTS);
            assert.ok(g.violations.some((v) => v.kind === 'number' && v.found === found), JSON.stringify(g.violations));
        });
    }

    it('each number is reported once however often it is said', () => {
        assert.deepEqual(guardReply('5000 ثم 5000 ثم ٥٠٠٠', FACTS).violations, [{ kind: 'number', found: '5000' }]);
    });

    it('a number that appears only in a link in the data is not a fact', () => {
        const linked: ClaimFacts = { texts: ['الرابط https://example.com/x/777?ref=88 مفيد'], prices: [] };
        assert.deepEqual(kinds(guardReply('رقم 777', linked).violations), ['number']);
    });

    it('a number the customer wrote is not a fact either: the reply may not echo "90% off" back', () => {
        // The guard is handed the data and the reply, never the customer's message, so an injected number has nowhere to hide.
        assert.deepEqual(kinds(guardReply('ما أقدر أعطيك خصم 90%', FACTS).violations).sort(), ['discount', 'number']);
    });
});

describe('guardReply: discounts, coupons and "free" are the data\'s to say', () => {
    const words: [string, string, string][] = [
        ['a discount', 'عندنا خصم للطلاب', 'discount'],
        ['a markdown', 'فيه تخفيض هالأسبوع', 'discount'],
        ['a discount, English', 'we have a discount for students', 'discount'],
        ['a coupon', 'استخدم كوبون SAVE', 'coupon'],
        ['a discount code', 'استخدم كود الخصم', 'coupon'],
        ['a promo code', 'use the promo code START', 'coupon'],
        ['free, in Arabic', 'التسجيل مجاني', 'free'],
        ['free, in Egyptian', 'الجزء ده بلاش', 'free'],
        ['free, in English', 'the first lesson is free', 'free'],
        ['free of charge', 'it is free of charge', 'free'],
    ];
    for (const [what, text, kind] of words) {
        it(`${what}: ${text}`, () => {
            const g = guardReply(text, FACTS);
            assert.ok(kinds(g.violations).includes(kind as never), JSON.stringify(g.violations));
        });
    }

    it('is allowed when the data says the same word', () => {
        const says: ClaimFacts = { texts: ['فيه خصم للطلاب الجامعيين', 'The first lesson is free'], prices: [] };
        assert.deepEqual(guardReply('فيه خصم للطلاب', says).violations, []);
        assert.deepEqual(guardReply('the first lesson is free', says).violations, []);
        // …but the other words are still not the data's.
        assert.deepEqual(kinds(guardReply('استخدم كوبون', says).violations), ['coupon']);
    });

    it('is seen through an Arabic prefix, a diacritic and a stretched letter', () => {
        assert.ok(kinds(guardReply('بالخصم', FACTS).violations).includes('discount'));
        assert.ok(kinds(guardReply('وكوبون', FACTS).violations).includes('coupon'));
        assert.ok(kinds(guardReply('مَجّانَاً', { texts: [], prices: [] }).violations).includes('free'));
    });
});

describe('stripLinks: the model never writes a link', () => {
    const cases: [string, string, string, string[]][] = [
        ['a URL with a scheme', 'التفاصيل هنا https://example.com/x/49?ref=77 وبس', 'التفاصيل هنا وبس', ['https://example.com/x/49?ref=77']],
        ['a URL before a full stop', 'See https://example.com/page.', 'See.', ['https://example.com/page']],
        ['a URL before an Arabic comma', 'تفضل https://example.com/a، وشكراً', 'تفضل، وشكراً', ['https://example.com/a']],
        ['http', 'http://example.com', '', ['http://example.com']],
        ['www', 'visit www.example.com/deals today', 'visit today', ['www.example.com/deals']],
        ['a bare domain with a path', 'اشتري من example.com/offer/49', 'اشتري من', ['example.com/offer/49']],
        ['a short link', 'check bit.ly/abc123 and wa.me/9665555', 'check and', ['bit.ly/abc123', 'wa.me/9665555']],
        ['an email address', 'write to someone@example.com please', 'write to please', ['someone@example.com']],
        ['a markdown link keeps its words', 'See [the page](https://example.com/p) now', 'See the page now', ['[the page](https://example.com/p)']],
        ['a link in angle brackets', 'link: <https://example.com/x>', 'link:', ['https://example.com/x']],
        ['a link in parentheses', 'ابدأ (https://example.com/start) الآن', 'ابدأ الآن', ['https://example.com/start']],
        ['a link in guillemets', 'الرابط «https://example.com/z»', 'الرابط', ['https://example.com/z']],
        ['a link in quotes', 'الرابط "https://example.com/z" هنا', 'الرابط هنا', ['https://example.com/z']],
        ['upper case', 'HTTPS://EXAMPLE.COM/X', '', ['HTTPS://EXAMPLE.COM/X']],
    ];
    for (const [what, text, expected, removed] of cases) {
        it(`${what}`, () => {
            const out = stripLinks(text);
            assert.equal(out.text, expected);
            assert.deepEqual(out.removed, removed);
        });
    }

    it('leaves text with no link exactly as it was, whitespace included', () => {
        for (const text of ['  هلا   والله  ', 'Version 2.0 is out.', 'e.g. this, i.e. that', 'Dr. Smith said 3.5', 'مرحبا. كيف حالك؟', 'Node.js and v2.0', 'a\n\n\nb']) {
            assert.deepEqual(stripLinks(text), { text, removed: [] }, text);
        }
    });

    it('takes out every link of a reply with several, and says how many', () => {
        const out = stripLinks('A https://a.example/x B www.b.example C c.example/y D');
        assert.equal(out.removed.length, 3);
        assert.equal(out.text, 'A B C D');
    });
});

describe('stripWomenEmoji: no content shows a woman or a girl, a model\'s emoji included', () => {
    const removed: [string, string][] = [
        ['woman', 'تمام 👩 جاهز'],
        ['woman technologist (a joined sequence)', 'تمام 👩‍💻 جاهز'],
        ['woman with a skin tone', 'تمام 👩🏽 جاهز'],
        ['girl', 'تمام 👧 جاهز'],
        ['a role emoji made female by the sign', 'تمام 🙋‍♀️ جاهز'],
        ['woman shrugging', 'تمام 🤷‍♀️ جاهز'],
        ['dancer', 'تمام 💃 جاهز'],
        ['a family that holds a woman', 'تمام 👨‍👩‍👧 جاهز'],
        ['headscarf', 'تمام 🧕 جاهز'],
    ];
    for (const [what, text] of removed) {
        it(`removes: ${what}`, () => {
            const out = stripWomenEmoji(text);
            assert.equal(out.removed, 1, text);
            assert.equal(out.text, 'تمام جاهز');
        });
    }

    it('keeps every other emoji, and every other character, as it was', () => {
        for (const text of ['تمام 🙏 جاهز', 'great 🚀👍🏽 go', '👨‍💻 builds', '🤖', 'عادي تماماً', '']) {
            assert.deepEqual(stripWomenEmoji(text), { text, removed: 0 }, text);
        }
    });

    it('counts each one it takes out', () => {
        assert.equal(stripWomenEmoji('👩 and 👧 and 💃').removed, 3);
    });
});

describe('guardReply: all of it together', () => {
    it('cleans first, then checks the cleaned text: the digits of a removed link are not numbers', () => {
        const g = guardReply('سجّل من https://example.com/x/7777?code=88 وبس 👩‍💻', FACTS);
        assert.equal(g.text, 'سجّل من وبس');
        assert.deepEqual(g.linksRemoved, ['https://example.com/x/7777?code=88']);
        assert.equal(g.womenEmojiRemoved, 1);
        assert.deepEqual(g.violations, []);
        assert.equal(g.ok, true);
    });

    it('reports a violation in what is left of a reply that also had a link', () => {
        const g = guardReply('السعر 49 ريال https://example.com/buy', FACTS);
        assert.equal(g.ok, false);
        assert.deepEqual(kinds(g.violations), ['price']);
        assert.equal(g.linksRemoved.length, 1);
    });

    it('checkClaims alone strips links first, so it is safe to call on text that still has one', () => {
        assert.deepEqual(checkClaims('https://example.com/x/7777', FACTS), []);
    });

    it('an empty reply, and a reply that is only a link, have nothing to refuse', () => {
        assert.equal(guardReply('', FACTS).ok, true);
        assert.equal(guardReply('https://example.com', FACTS).text, '');
    });
});

// ─── The allowlist (S6): the creator's own addresses, and the link the server inserts ─────────

describe('stripLinks and guardReply: only an EXACT match to an allowed address survives', () => {
    const SITE = 'https://creator.example';
    const SOCIAL = 'https://instagram.com/the.creator';
    const OFFER = 'https://shop.example/product?code=AB12CD';
    const allowed = [SITE, SOCIAL, OFFER];

    it('keeps an allowed link as written, and takes out every other link of the same reply', () => {
        const out = stripLinks(`Follow ${SOCIAL} or see https://elsewhere.example/x today.`, allowed);
        assert.equal(out.text, `Follow ${SOCIAL} or see today.`);
        assert.deepEqual(out.removed, ['https://elsewhere.example/x'], 'the kept one is not in what was removed');
    });

    it('keeps the sentence\'s own punctuation after a kept link, in both scripts', () => {
        assert.equal(stripLinks(`Visit ${SITE}.`, allowed).text, `Visit ${SITE}.`);
        assert.equal(stripLinks(`زر ${SITE}، وشكراً`, allowed).text, `زر ${SITE}، وشكراً`);
    });

    it('does not mind the scheme, a leading www. or a closing slash, nor the case of the host', () => {
        for (const written of ['http://creator.example', 'https://www.creator.example', 'https://creator.example/', 'HTTPS://CREATOR.EXAMPLE', 'creator.example/']) {
            const out = stripLinks(`See ${written} now`, allowed);
            assert.deepEqual(out.removed, [], written);
            assert.ok(out.text.includes(written), `${written} kept: ${out.text}`);
        }
    });

    it('takes out a link that differs by a path, a query or a letter: a near match is another address', () => {
        for (const near of [
            'https://instagram.com/the.creator2', 'https://instagram.com/the.creato', 'https://instagram.com/the.creator/reels', 'https://instagram.com/The.Creator',
            'https://shop.example/product?code=AB12CE', 'https://shop.example/product?code=ab12cd', 'https://shop.example/product', 'https://shop.example/product?code=AB12CD&x=1',
            'https://creator.example.evil.example', 'https://evil-creator.example', 'https://creator.example@evil.example',
        ]) {
            const out = stripLinks(`See ${near} now`, allowed);
            assert.equal(out.removed.length >= 1, true, near);
            assert.ok(!out.text.includes('evil') && !out.text.includes(near), `${near} is gone: ${out.text}`);
        }
    });

    it('keeps a markdown link\'s words and its address when the address is allowed, and only its words when it is not', () => {
        assert.equal(stripLinks(`See [my page](${SITE}) now`, allowed).text, `See my page ${SITE} now`);
        assert.equal(stripLinks('See [my page](https://elsewhere.example) now', allowed).text, 'See my page now');
    });

    it('is the strict rule when nothing is allowed: the same text loses its links', () => {
        assert.equal(stripLinks(`Follow ${SOCIAL}`).text, 'Follow');
        assert.equal(stripLinks(`Follow ${SOCIAL}`, []).text, 'Follow');
    });

    it('a kept link is not broken by the patterns that run after the one that found it (a www. address inside a scheme address)', () => {
        const out = stripLinks('Go to https://www.creator.example/a/b/c now', ['https://www.creator.example/a/b/c']);
        assert.equal(out.text, 'Go to https://www.creator.example/a/b/c now');
        assert.deepEqual(out.removed, []);
    });

    it('still takes out an email address and a bare domain that is not on the list', () => {
        const out = stripLinks(`${SITE} or me@creator.example or example.org/x`, allowed);
        assert.equal(out.text, `${SITE} or or`);
        assert.deepEqual(out.removed, ['me@creator.example', 'example.org/x']);
    });

    it('a kept link\'s digits are not numbers the data must hold: guardReply checks the claims on the text without links', () => {
        const facts: ClaimFacts = { texts: ['12 lessons'], prices: [], allowedLinks: ['https://creator.example/p/2024?x=9987'] };
        const g = guardReply('The 12 lessons are at https://creator.example/p/2024?x=9987 for you.', facts);
        assert.deepEqual(g.violations, []);
        assert.ok(g.text.includes('https://creator.example/p/2024?x=9987'), 'and the link is still in what is sent');
        assert.equal(g.linksRemoved.length, 0);
    });

    it('a number in a link the model was NOT allowed is gone with the link, and a claim beside a kept link is still a claim', () => {
        const facts: ClaimFacts = { texts: [], prices: [], allowedLinks: [SITE] };
        assert.deepEqual(guardReply(`See ${SITE} and https://other.example/77`, facts).violations, []);
        assert.deepEqual(kinds(guardReply(`Only 25 dollars at ${SITE}`, facts).violations), ['price']);
    });

    it('guardReply with no allowedLinks is the strict rule it was', () => {
        const g = guardReply(`See ${SITE}`, { texts: [], prices: [] });
        assert.equal(g.text, 'See');
        assert.deepEqual(g.linksRemoved, [SITE]);
    });
});

describe('linkKey: what makes two addresses one', () => {
    it('is the host in lower case and the rest as written, without scheme, www. or closing slashes', () => {
        assert.equal(linkKey('HTTPS://WWW.Example.COM/Path?Q=1'), 'example.com/Path?Q=1');
        assert.equal(linkKey('example.com///'), 'example.com');
        assert.equal(linkKey(' https://example.com '), 'example.com');
        assert.notEqual(linkKey('https://example.com/a'), linkKey('https://example.com/A'));
        assert.notEqual(linkKey('https://example.com/a?x=1'), linkKey('https://example.com/a?x=2'));
        assert.notEqual(linkKey('https://example.com/a'), linkKey('https://example.com/a#frag'));
    });
});
