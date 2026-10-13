/**
 * The SHARED SITE CHROME — the CSS block, the navbar and the footer — must be the same in all
 * six public pages.
 *
 * There is no build step and no templating: `public/*.html` are standalone files behind
 * hardcoded Express routes, so the only way to share chrome is to paste it six times. Every page
 * says so in a comment ("MEANT TO BE BYTE-IDENTICAL"), and for weeks nothing enforced it except
 * a person re-hashing the blocks by hand after each change. This does it on every `npm test`.
 *
 * The one intended difference is `aria-current="page"` on the link that points at the page you
 * are reading (the wordmark on the landing page, Pricing on pricing, the page's own Legal link on
 * the legal pages, nothing on the 404). That attribute is removed before comparing; any other
 * difference is drift.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const PAGES = ['landing', 'pricing', 'privacy', 'terms', 'data-deletion', '404'] as const;

const read = (p: string) => readFileSync(`public/${p}.html`, 'utf8');

type Chrome = { css: string; nav: string; foot: string };

/** Each block runs from the `═══` comment that opens it to the tag that closes it. */
function chromeOf(html: string, page: string): Chrome {
    const at = (marker: string): number => {
        const first = html.indexOf(marker);
        assert.ok(first >= 0, `${page}: "${marker}" is missing`);
        assert.equal(html.indexOf(marker, first + 1), -1, `${page}: "${marker}" appears more than once`);
        return first;
    };
    const css0 = at('SHARED SITE CHROME · CSS');
    const nav0 = at('SHARED SITE CHROME · NAVBAR');
    const foot0 = at('SHARED SITE CHROME · FOOTER');
    const opens = (marker: number, open: string): number => {
        const i = html.lastIndexOf(open, marker);
        assert.ok(i >= 0, `${page}: no ${open} before the chrome marker`);
        return i;
    };
    const closes = (marker: number, close: string): number => {
        const i = html.indexOf(close, marker);
        assert.ok(i >= 0, `${page}: no ${close} after the chrome marker`);
        return i + close.length;
    };
    const strip = (block: string) => block.replace(/ aria-current="page"/g, '');
    return {
        css: strip(html.slice(opens(css0, '/* ═'), html.indexOf('</style>', css0))),
        nav: strip(html.slice(opens(nav0, '<!-- ═'), closes(nav0, '</header>'))),
        foot: strip(html.slice(opens(foot0, '<!-- ═'), closes(foot0, '</footer>'))),
    };
}

const chrome = new Map(PAGES.map((p) => [p, chromeOf(read(p), p)] as const));

describe('public pages — the shared chrome is identical on all six', () => {
    for (const block of ['css', 'nav', 'foot'] as const) {
        it(`${block}: the same text on every page, aria-current aside`, () => {
            const reference = chrome.get('landing')![block];
            assert.ok(reference.length > 1000, `the ${block} block was found and is not empty`);
            for (const p of PAGES) {
                assert.equal(chrome.get(p)![block], reference, `${p}.html: the ${block} block has drifted from landing.html`);
            }
        });
    }

    /**
     * The links each page marks as the one you are on, in source order: the nav's and the
     * footer's. Pinned per page rather than counted, so a copy that marks the wrong link (or
     * none) is caught, and so is a page that quietly gains a second current link.
     */
    const CURRENT: Record<(typeof PAGES)[number], string[]> = {
        landing: ['/', '/'],             // the wordmark in the bar, the wordmark in the footer
        pricing: ['/pricing', '/pricing'], // its link in the bar, its link in the footer
        privacy: ['/privacy'],           // not a destination in the bar: its footer link only
        terms: ['/terms'],
        'data-deletion': ['/data-deletion'],
        '404': [],                       // not a page anyone is "on"
    };

    for (const p of PAGES) {
        it(`${p}: marks exactly ${CURRENT[p].length ? CURRENT[p].join(' and ') : 'nothing'} as current, and nothing else differs`, () => {
            const html = read(p);
            // On a link, not in the comment that explains the attribute.
            const marked = [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)].map((m) => /href="([^"]*)"/.exec(m[0])?.[1]);
            assert.deepEqual(marked, CURRENT[p]);
            const c = chromeOf(html, p);
            assert.equal(/<a\b[^>]*aria-current/.test(c.nav + c.foot), false, `${p}: a link still carries aria-current after normalising`);
        });
    }
});

describe('public pages — the footer says what the product is now (L4)', () => {
    const foot = chrome.get('landing')!.foot;

    it('opens with the studio positioning, in both languages', () => {
        assert.ok(foot.includes('استوديو نموّ مُدار لصنّاع المحتوى العرب: ريلز وكاروسيل وإنفوجرافيك'));
        assert.ok(foot.includes('A managed growth studio for Arabic creators: reels, carousels and infographics'));
        assert.ok(foot.includes('and comments into private messages'), 'the comment-to-DM loop is last, not first');
    });

    it('names no AI reply and no DM bot', () => {
        assert.equal(/الذكاء الاصطناعي|\bAI\b|🤖/.test(foot), false);
    });

    it('the Product group links to the Monteur and Infographics, which the landing page can resolve', () => {
        assert.ok(foot.includes('href="/#monteur"'));
        assert.ok(foot.includes('href="/#infographics"'));
        // The landing script resolves a language-neutral fragment to `<name>-<lang>`.
        const landing = read('landing');
        for (const name of ['monteur', 'infographics']) {
            for (const lang of ['ar', 'en']) {
                assert.ok(landing.includes(`id="${name}-${lang}"`), `#${name}-${lang} exists`);
            }
        }
    });

    it('keeps the GitHub links while the owner decides (CLAUDE.md, Known issues)', () => {
        assert.ok(foot.includes('https://github.com/ElAmir-Mansour/instagram-dm-automation"'));
        assert.ok(foot.includes('instagram-dm-automation/issues'));
    });
});

describe('public pages — the legal line names every trademark the footer draws (L8)', () => {
    const legal = (page: (typeof PAGES)[number]) => {
        const m = /<p class="foot-legal">([\s\S]*?)<\/p>/.exec(chrome.get(page)!.foot.replace(/<!--[\s\S]*?-->/g, ''));
        assert.ok(m, `${page}: the legal line`);
        return m[1]!;
    };

    for (const page of PAGES) {
        it(`${page}: names WhatsApp, YouTube and Google, in both languages, and still disclaims endorsement`, () => {
            const line = legal(page);
            const ar = /<bdi class="t-ar"[^>]*>([\s\S]*?)<\/bdi>\s*<bdi class="t-en"/.exec(line)![1]!;
            const en = /<bdi class="t-en"[^>]*>([\s\S]*?)<\/bdi>\s*$/.exec(line)![1]!;
            // Arabic: the five marks (the glossary's spellings), Meta and Google as the companies it is not.
            for (const mark of ['إنستجرام', 'فيسبوك', 'واتساب', 'تيك توك', 'يوتيوب']) assert.ok(ar.includes(mark), `${page}: ${mark}`);
            assert.ok(ar.includes('<bdi lang="en" dir="ltr">Meta</bdi>') && ar.includes('<bdi lang="en" dir="ltr">Google</bdi>'), `${page}: Meta and Google, each isolated`);
            assert.ok(ar.includes('ولا ترتبط هذه الأداة') && ar.includes('تأييد'), `${page}: not affiliated, not endorsed`);
            // English: the five trademarks, then the three companies.
            assert.ok(en.includes('Instagram, Facebook, WhatsApp, TikTok and YouTube are trademarks of their respective owners'), page);
            assert.ok(en.includes('is not affiliated with, or endorsed by, Meta, TikTok or Google.'), page);
        });
    }

    it("the Follow row carries the founder's YouTube channel too, on every page", () => {
        for (const page of PAGES) {
            assert.ok(chrome.get(page)!.foot.includes('href="https://www.youtube.com/@elamir"'), page);
        }
    });
});
