/**
 * What the landing page and the pricing page SAY, pinned (L4, "truth and positioning").
 *
 * These pages are read by Meta, TikTok and Google reviewers and by prospects, so a sentence on
 * them is a claim about the product. Four of those claims were untrue and are guarded here so
 * they cannot drift back:
 *
 *   - that AI answers direct messages (the DM bot is parked until the Meta app is verified);
 *   - that all of the code is open source (only the server is; the worker and the Monteur and
 *     infographic templates are private);
 *   - a hero example that used a woman's name (owner rule: no women or girls in content);
 *   - a hero that sold a DM bot, when the product is a growth studio.
 *
 * The page's header comment is a claim ledger and quotes some of the removed claims as history,
 * so every check on the page's words runs on the markup with its HTML comments removed.
 */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { renderSiteTemplate } from './publicPages.js';

const read = (p: string) => readFileSync(p, 'utf8');
const landing = read('public/landing.html');
const pricing = read('public/pricing.html');

const noComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');

/** What a visitor can read: no comments, and none of the page's own CSS or script. */
const visibleText = (html: string) =>
    noComments(html)
        .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, '')
        .replace(/<\/?(?:bdi|a|span|strong|em|b)\b[^>]*>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ');

/** The two language documents of a bilingual page, comments removed. */
function articles(html: string): { ar: string; en: string } {
    const clean = noComments(html);
    const ar = clean.indexOf('<article class="doc" data-doc-lang="ar"');
    const en = clean.indexOf('<article class="doc" data-doc-lang="en"');
    const end = clean.indexOf('</main>');
    assert.ok(ar > 0 && en > ar && end > en, 'both articles and </main> are present, in order');
    return { ar: clean.slice(ar, en), en: clean.slice(en, end) };
}

/**
 * Visible words: the markup's tags and its attribute values are gone. An inline tag leaves no
 * gap (a <bdi> inside a sentence is part of it); any other tag is a break.
 */
const words = (html: string) =>
    html
        .replace(/<\/?(?:bdi|a|span|strong|em|b)\b[^>]*>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ');

const L = articles(landing);
const P = articles(pricing);

const ALL = { whatsappNumber: '966501234567', contactEmail: 'hello@example.com', eidCouponsExpire: null };
const BARE = { whatsappNumber: null, contactEmail: 'hello@example.com', eidCouponsExpire: null };

describe('landing — Arabic and English documents match', () => {
    const ids = (html: string, suffix: string) =>
        [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!).filter((id) => id.endsWith(suffix));

    it('every id ending -ar has its -en twin, and the reverse', () => {
        const ar = ids(L.ar, '-ar').map((id) => id.slice(0, -3));
        const en = ids(L.en, '-en').map((id) => id.slice(0, -3));
        assert.ok(ar.length > 15, 'the ids were found');
        assert.deepEqual([...ar].sort(), [...en].sort());
        // ...and nothing in an article carries the other language's suffix, or none.
        const every = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
        assert.deepEqual(every(L.ar).filter((id) => !id.endsWith('-ar')), []);
        assert.deepEqual(every(L.en).filter((id) => !id.endsWith('-en')), []);
    });

    it('every section id ending -ar in the file has an -en twin (whole file, not just the articles)', () => {
        const all = (suffix: string) => ids(noComments(landing), suffix).map((id) => id.slice(0, -3));
        assert.deepEqual(all('-ar').sort(), all('-en').sort());
    });

    it('the same number of h2, sections, FAQ entries and requirement rows in each language', () => {
        const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;
        for (const re of [/<h2[\s>]/g, /<section[\s>]/g, /<details[\s>]/g, /<ul class="card reqs">[\s\S]*?<\/ul>/g]) {
            assert.equal(count(L.ar, re), count(L.en, re), String(re));
        }
        assert.equal(count(L.ar, /<h2[\s>]/g), 16);
        assert.equal(count(L.ar, /<li>\s*<h3>/g), count(L.en, /<li>\s*<h3>/g), 'the platform rows match');
    });

    it('every aria-labelledby and in-page link points at an id in its own language', () => {
        for (const [doc, suffix] of [[L.ar, '-ar'], [L.en, '-en']] as const) {
            const have = new Set([...doc.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
            for (const m of doc.matchAll(/aria-labelledby="([^"]+)"/g)) assert.ok(have.has(m[1]!), `${m[1]} (${suffix})`);
            // A link, not a logo: `<use href="#plogo-…">` points at the sprite after <body>, outside both
            // articles, and landingLogos.test.ts checks that every one of those resolves.
            for (const m of doc.matchAll(/(?<!<use )href="#([^"]+)"/g)) assert.ok(have.has(m[1]!), `#${m[1]} (${suffix})`);
        }
    });

    it('the Monteur and Infographics bands follow the Studio bands and precede the real work', () => {
        for (const [doc, s] of [[L.ar, 'ar'], [L.en, 'en']] as const) {
            const at = (id: string) => doc.indexOf(`id="${id}"`);
            const order = [`studio-how-${s}`, `monteur-${s}`, `infographics-${s}`, `samples-${s}`].map(at);
            assert.ok(order.every((i) => i > 0), s);
            assert.deepEqual([...order].sort((a, b) => a - b), order, `${s}: studio-how, monteur, infographics, samples`);
            // Each band has exactly one h2, and the band is labelled by it.
            for (const name of ['monteur', 'infographics']) {
                assert.ok(doc.includes(`aria-labelledby="${name}-h-${s}"`), `${name}-${s}`);
                assert.ok(doc.includes(`<h2 id="${name}-h-${s}">`), `${name}-${s} h2`);
            }
        }
    });

    it('the Monteur and Infographics have a requirements row each, in both languages', () => {
        assert.ok(L.ar.includes('<h3>المونتير</h3>') && L.ar.includes('<h3>الإنفوجرافيك</h3>'));
        assert.ok(L.en.includes('<h3>Monteur</h3>') && L.en.includes('<h3>Infographics</h3>'));
        assert.ok(words(L.ar).includes('جهاز ماك عليه «العامل»، ومجلد لفيديوهاتك الطويلة'));
        assert.ok(words(L.en).includes('A Mac running the worker, and a folder for your long videos'));
        for (const doc of [L.ar, L.en]) {
            assert.ok(/حسابات المؤسس وحدها|founder's accounts only/.test(words(doc)), 'infographics say who it runs for today');
        }
    });
});

describe('landing — no claim that AI answers direct messages (P0-1)', () => {
    const CLAIMS = [
        /🤖/u,
        /AI takes the rest/,
        /الذكاء الاصطناعي بقيّة|الذكاء\s+الاصطناعي\s+بقيّة/,
        /رد آلي من المساعد/,
        /AI (?:replies|answers)|AI answers whatever/i,
        /ردود الذكاء الاصطناعي/,
        /Can the AI get an answer wrong/i,
        /هل يخطئ الذكاء الاصطناعي/,
        /thread the AI reads|messages of the thread/i,
        /Messenger conversations|محادثات ماسنجر/,
        /خدمة آلية/, // the disclosure line belonged to the AI reply path
        /automated service/i,
        // The broad shapes a reworded claim would take, not just the strings that were removed.
        /(?:يجيب|يردّ)[^.؟]{0,30}بالذكاء الاصطناعي/,
        /\bAI\b[^.]{0,40}\b(?:repl|answer|conversation|message)/i,
    ];

    for (const [name, html] of [['landing', landing], ['pricing', pricing]] as const) {
        it(`${name}: none of the removed claims is in the visible markup`, () => {
            const visible = visibleText(html);
            for (const re of CLAIMS) assert.equal(re.test(visible), false, `${name}: ${re}`);
        });
    }

    it('the grep the PR is accepted by finds nothing, comments included', () => {
        for (const html of [landing, pricing]) {
            assert.equal(/🤖|AI takes the rest|الذكاء الاصطناعي بقيّة/.test(html), false);
        }
    });

    it('landing: the second beat is the campaign\'s own text, with its two limits', () => {
        assert.ok(words(L.ar).includes('نصُّ الحملة يصل صاحبَ التعليق على الخاص'));
        assert.ok(words(L.ar).includes('رسالة آلية واحدة للشخص نفسه كل 24 ساعة، و180 رسالة في الساعة لكل حساب على الأكثر'));
        assert.ok(words(L.en).includes('One automated message per person every 24 hours, and at most 180 an hour per account'));
    });

    it('landing: two fixed numbers, not three, and no card for AI replies', () => {
        for (const doc of [L.ar, L.en]) {
            const figures = /<dl class="figures">[\s\S]*?<\/dl>/.exec(doc);
            assert.ok(figures);
            assert.deepEqual([...figures[0].matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]), ['180', '24']);
            assert.equal(/aria-labelledby="f2-/.test(doc), false, 'the f2 card is gone');
        }
        assert.ok(L.ar.includes('ورقمان ثابتان في البرنامج نفسه'));
        assert.ok(L.en.includes('And two numbers fixed in the software itself'));
    });

    it('landing: the "AI wrong" question is replaced by "does anything go out without me seeing it"', () => {
        assert.ok(L.ar.includes('<summary>هل يُنشر شيء دون أن أراه؟</summary>'));
        assert.ok(L.en.includes('<summary>Does anything go out without me seeing it?</summary>'));
        assert.ok(words(L.ar).includes('في الوضع الافتراضي، لا: ريلز المونتير تنتظر اعتمادك واحداً واحداً'));
        assert.ok(words(L.en).includes("By default, no: the Monteur's reels wait for your approval one by one"));
    });

    it('landing: the platform rows describe comments, scheduling and performance only', () => {
        assert.ok(words(L.ar).includes('من التعليق إلى الرسالة الخاصة، وجدولة الصور والريلز والكاروسيل، وقراءة أداء المنشورات'));
        assert.ok(words(L.ar).includes('من تعليقات الصفحة إلى الرسالة الخاصة، وجدولة المنشورات والفيديو والكاروسيل'));
        assert.ok(words(L.en).includes('Comment-to-DM campaigns, scheduled photos, reels and carousels, and post performance'));
        assert.ok(words(L.en).includes('Comment-to-DM on Page posts, and scheduled posts, video and carousels'));
    });

    it('the meta description names no AI reply, and the Arabic one fits 155 characters', () => {
        const meta = (lang: string) =>
            new RegExp(`<meta name="description" data-lang-only="${lang}" content="([^"]*)"`).exec(landing)![1]!;
        assert.ok(meta('ar').length <= 155, String(meta('ar').length));
        for (const lang of ['ar', 'en']) {
            assert.equal(/الذكاء الاصطناعي|\bAI\b|answers the conversation/.test(meta(lang)), false, lang);
        }
    });

    it('pricing: every direct-message row is one row, "after Meta approves the app", not included today', () => {
        for (const [doc, label, cell] of [
            [P.ar, 'الردود الآلية على الرسائل — بعد اعتماد ميتا للتطبيق', 'غير متاحة اليوم'],
            [P.en, 'Automated replies to messages — after Meta approves the app', 'Not available today'],
        ] as const) {
            const group = /<tbody>\s*<tr><th scope="rowgroup" colspan="4">(?:الرسائل الخاصة|Direct messages)<\/th><\/tr>[\s\S]*?<\/tbody>/.exec(doc);
            assert.ok(group, 'the direct-messages group exists');
            assert.equal((group[0].match(/<th scope="row"/g) ?? []).length, 1, 'exactly one row');
            assert.ok(group[0].includes(label) && group[0].includes(cell));
            assert.equal(group[0].includes('class="yes"'), false, 'not marked as included');
        }
    });

    it('pricing: the follower-disclosure FAQ and the language-model bullet are gone', () => {
        for (const doc of [P.ar, P.en]) {
            assert.equal(/خدمة آلية|automated service|نموذج لغوي|language model|Gemini|جوجل لتوليد|Google to generate/i.test(words(doc)), false);
        }
        assert.ok(P.ar.includes('<summary>هل يُنشر شيء دون أن أراه؟</summary>'));
        assert.ok(P.en.includes('<summary>Does anything go out without me seeing it?</summary>'));
    });
});

describe('landing and pricing — no claim that all the code is open (P0-2)', () => {
    /** Occurrences of the licence name in what a visitor reads. */
    const mit = (doc: string) => (words(doc).match(/\bMIT\b/g) ?? []).length;

    it('landing: MIT is named once per language, in the open-source FAQ, and says only the server is', () => {
        assert.equal(mit(L.ar), 1);
        assert.equal(mit(L.en), 1);
        assert.ok(L.ar.includes('<summary>هل البرنامج مفتوح المصدر؟</summary>'));
        assert.ok(words(L.ar).includes('الخادم الذي يستقبل التعليقات ويرسل الرسائل وينشر مفتوحٌ برخصة MIT على GitHub؛ أمّا العامل وقوالب المونتير والإنفوجرافيك فليست مفتوحة المصدر'));
        assert.ok(L.en.includes('<summary>Is it open source?</summary>'));
        assert.ok(words(L.en).includes('The server that receives comments, sends messages and publishes is MIT-licensed on GitHub. The worker and the Monteur and infographic templates are not.'));
    });

    it('landing: what is sold is "a service, not a licence"', () => {
        assert.ok(L.ar.includes('<p class="pane-label">خدمة، لا ترخيص</p>'));
        assert.ok(L.en.includes('<p class="pane-label">A service, not a licence</p>'));
    });

    it('landing: the licence pane and the closing line are gone', () => {
        for (const doc of [L.ar, L.en]) {
            assert.equal(/class="lic"|class="cta-foot"|class="pane-label">(?:مفتوح المصدر|Open source)/.test(doc), false);
            assert.equal(/المستودع العلني|the public repository|Or run it yourself|أو شغّله بنفسك/.test(doc), false);
        }
    });

    it('pricing: the callout no longer says the software is open, and the FAQ says what is', () => {
        assert.equal(mit(P.ar), 1);
        assert.equal(mit(P.en), 1);
        for (const doc of [P.ar, P.en]) {
            assert.equal(/البرنامج نفسه مفتوح المصدر|software itself is open source|الكود مفتوح المصدر|code is open source/.test(words(doc)), false);
            assert.equal(/Gemini/.test(doc), false, 'the self-host answer no longer asks for a Gemini key');
        }
        assert.ok(P.ar.includes('<summary>هل البرنامج مفتوح المصدر؟</summary>'));
        assert.ok(P.en.includes('<summary>Is it open source?</summary>'));
    });

    it('the footer GitHub links stay (owner decision pending)', () => {
        for (const html of [landing, pricing]) {
            assert.ok(html.includes('href="https://github.com/ElAmir-Mansour/instagram-dm-automation"'));
        }
    });
});

describe('landing — the hero sells a growth studio (P0-3) and no woman appears in it (P0-5)', () => {
    const hero = (doc: string) => /<section class="hero"[\s\S]*?<\/section>/.exec(doc)![0];

    it('says what the product is, in both languages, and drops Sign in from the hero', () => {
        assert.ok(hero(L.ar).includes('استوديو نموّ مُدار لصنّاع المحتوى العرب'));
        assert.ok(hero(L.ar).includes('<h1 id="hero-ar">فيديوهاتك تصير منشورات، وتعليقاتهم تصير محادثات</h1>'));
        assert.ok(hero(L.en).includes('A managed growth studio for Arabic creators'));
        assert.ok(hero(L.en).includes('<h1 id="hero-en">Your videos become posts. Their comments become conversations.</h1>'));
        assert.ok(words(hero(L.ar)).includes('المونتير يقصّ من فيديوهاتك الطويلة ريلز، والاستوديو يكتب من دروسك كاروسيلاً'));
        assert.ok(words(hero(L.en)).includes('The Monteur cuts reels from your long videos and the Studio writes carousels from your lessons'));
        for (const doc of [L.ar, L.en]) {
            assert.equal(/href="\/dashboard"/.test(hero(doc)), false, 'no Sign in in the hero');
            assert.equal(/href="\/pricing"/.test(hero(doc)), false);
        }
    });

    it('the primary button is WhatsApp while there is a number and the contact block while there is not', () => {
        for (const lang of ['ar', 'en'] as const) {
            const full = renderSiteTemplate(landing, ALL, lang);
            const bare = renderSiteTemplate(landing, BARE, lang);
            const heroOf = (html: string) =>
                new RegExp(`<section class="hero" aria-labelledby="hero-${lang}"[\\s\\S]*?</section>`).exec(html)![0];
            const buttons = (html: string) => [...heroOf(html).matchAll(/<a class="btn (btn-(?:primary|secondary))"[^>]*href="([^"]*)"/g)].map((m) => [m[1], m[2]]);
            const withNumber = buttons(full);
            assert.equal(withNumber.length, 2, lang);
            assert.equal(withNumber[0]![0], 'btn-primary');
            assert.ok(withNumber[0]![1]!.startsWith('https://wa.me/966501234567'), lang);
            assert.deepEqual(withNumber[1], ['btn-secondary', `#samples-${lang}`]);
            const without = buttons(bare);
            assert.deepEqual(without, [['btn-primary', `#contact-${lang}`], ['btn-secondary', `#samples-${lang}`]]);
            assert.equal(heroOf(bare).includes('wa.me'), false);
        }
    });

    it('both hero buttons point somewhere that exists', () => {
        for (const [doc, s] of [[L.ar, 'ar'], [L.en, 'en']] as const) {
            assert.ok(doc.includes(`id="samples-${s}"`));
            assert.ok(doc.includes(`id="contact-${s}"`));
        }
    });

    it('the example commenter is Salem, with our message in formal Arabic, and nobody is a woman', () => {
        const art = (doc: string) => /<aside class="card artifact" aria-label="[^"]*">[\s\S]*?<\/aside>/.exec(doc)![0];
        assert.ok(art(L.ar).includes('aria-hidden="true">س</span>') && art(L.ar).includes('</span>سالم</p>'));
        assert.ok(art(L.ar).includes('أهلاً سالم! هذه تفاصيل الأسعار والتوصيل.'));
        assert.ok(art(L.ar).includes('كم <span class="kw">السعر</span>؟ وهل فيه توصيل؟'), "the customer's comment stays colloquial: it is a quote");
        assert.ok(art(L.en).includes('aria-hidden="true">S</span>') && art(L.en).includes('</span>Salem</p>'));
        assert.ok(art(L.en).includes('Hi Salem! Here are the prices and delivery options.'));
        for (const html of [landing, pricing]) {
            assert.equal(/نورة|Noura/.test(html), false, 'the female persona is gone, comments included');
        }
        assert.equal(/هذي/.test(art(L.ar)), false, 'no dialect in our own line');
    });

    it('the contact block asks what you publish, and keeps the WhatsApp and email placeholders', () => {
        assert.ok(L.ar.includes('قل لنا ماذا تنشر ولمن، ونقترح ما نُشغّله لك أولاً، مع السعر ومدة الإعداد، قبل أي التزام.'));
        assert.ok(L.en.includes('Tell us what you publish and who for. We suggest what to switch on first, with the price and setup time, before you commit to anything.'));
        assert.ok(landing.includes('href="{{WHATSAPP_URL}}"') && landing.includes('mailto:{{CONTACT_EMAIL}}'));
    });
});

describe('landing — Latin runs inside Arabic are isolated (DESIGN.draft §3)', () => {
    it('9:16, 4:5, GIF, MP4, RAG vs CAG vs KAG, MIT, GitHub, Shorts and the clock times never sit bare in the Arabic document', () => {
        // Remove each <bdi>…</bdi> run, then every tag (attribute values go with them): what is
        // left is the text a bidi algorithm would have to reorder. The existing page wraps
        // these in <bdi>; so must the new bands.
        const bare = L.ar.replace(/<bdi\b[^>]*>[^<]*<\/bdi>/g, ' ').replace(/<[^>]+>/g, ' ');
        // (04:12 is left out on purpose: the Studio band's screenshot clock has always been bare,
        // pinned left-to-right by its own CSS; the new bands' clocks are 11:40 and 23:05.)
        for (const token of ['9:16', '4:5', 'GIF', 'MP4', 'RAG', 'CAG', 'KAG', 'MIT', 'GitHub', 'Shorts', '11:40', '23:05']) {
            assert.equal(bare.includes(token), false, `"${token}" is not wrapped in <bdi> in the Arabic document`);
        }
    });

    it('the glossary spellings are used, and the variant ones are not', () => {
        const ar = words(L.ar);
        for (const term of ['المونتير', 'الإنفوجرافيك', 'إنستجرام', 'ريلز', 'كاروسيل']) assert.ok(ar.includes(term), term);
        for (const variant of ['إنستغرام', 'انستجرام', 'انفوجرافيك', 'منتير']) {
            assert.equal(ar.includes(variant), false, variant);
        }
    });
});

describe('landing — the new bands carry no image request and no person', () => {
    it('the artifacts are CSS: no <img> inside the Monteur or Infographics bands', () => {
        for (const [doc, s] of [[L.ar, 'ar'], [L.en, 'en']] as const) {
            for (const name of ['monteur', 'infographics']) {
                const start = doc.indexOf(`id="${name}-${s}"`);
                const end = doc.indexOf('</section>', start);
                const band = doc.slice(start, end);
                assert.ok(band.includes('role="img"'), `${name}-${s}: the artifact is one labelled picture`);
                assert.equal(/<img\b|<video\b|url\(/.test(band), false, `${name}-${s}`);
            }
        }
    });
});

describe('landing — the new CSS: logical properties, existing breakpoints, tokens only', () => {
    const css = /<style>[\s\S]*?<\/style>/.exec(landing)![0];
    const comments = /\/\*[\s\S]*?\*\//g;

    /** One rule, from its selector to its closing brace, comments removed. */
    function rule(selector: string): string {
        const at = css.indexOf(selector);
        assert.ok(at >= 0, `${selector} is in the page's CSS`);
        return css.slice(at, css.indexOf('}', at) + 1).replace(comments, '');
    }
    /** Everything from one marker to another (the end marker's text is included). */
    function between(from: string, to: string): string {
        const a = css.indexOf(from);
        const b = css.indexOf(to, a);
        assert.ok(a >= 0 && b > a, `${from} … ${to}`);
        return css.slice(a, b + to.length).replace(comments, '');
    }

    /** Every piece of CSS this change wrote. */
    const mine = [
        // the two bands' artifacts, from their opening comment to the next section's
        css.slice(css.indexOf('The Monteur and Infographics'), css.indexOf("The Studio's closing detail list")).replace(comments, ''),
        // the capabilities pair left with one card
        rule('.duo > .card:only-child {'),
        rule('.duo > .card:only-child p {'),
        // what you pay for: one pane, the sold list two by two, the plans row across the bottom
        rule('.pays {'),
        rule('.pays .sold {'),
        rule('.pays > .plans {'),
        // the 320px additions inside the narrow block (the .slide rule they follow is older)
        between('.cut { grid-template-columns: minmax(0, 1fr) minmax(0, 7.5rem)', '.cmp-col { padding: 0.3rem; }'),
        // the shared slide / comparison-card look
        rule('.slide,\n        .cmp {'),
        // the platform logos (L8): the base mark, the button's, the rows' tiles, the samples' marks, the
        // footer's. Not the three --logo-* token blocks: a colour literal is allowed there and only there.
        rule('\n        .plogo {'),
        rule('.plogo-yt {'),
        rule('.btn > .plogo {'),
        rule('.reqs h3 {'),
        rule('.ptile {'),
        rule('.ptile-instagram {'),
        rule('.ptile-facebook {'),
        rule('.ptile-tiktok {'),
        rule('.ptile-youtube {'),
        rule('.live a > .plogo {'),
        rule('.reel figcaption .plogo {'),
        rule('.reel figcaption .nw {'),
        rule('.pagefoot .foot-social .plogo {'),
        rule('.pagefoot .foot-wa .plogo {'),
        // the diagrams, the platform map and the real infographic (L9): everything between its header and
        // the next section's
        between('Diagrams, and the real infographic (L9)', '/* ─── Security and privacy').replace(comments, ''),
    ].join('\n');

    const PHYSICAL = [
        /\b(?:margin|padding)-(?:left|right)\b/,
        /\bborder-(?:left|right)\b/,
        /\bborder-(?:top|bottom)-(?:left|right)-radius\b/,
        /(?<![-\w])(?:left|right)\s*:/,
        /\bfloat\s*:/,
        /text-align\s*:\s*(?:left|right)\b/,
    ];

    it('has no physical left/right, float, or text-align: left|right', () => {
        for (const re of PHYSICAL) assert.equal(re.test(mine), false, String(re));
    });

    it('the guard is not blind: every pattern matches the thing it is for, and not its logical twin', () => {
        const caught = ['margin-left: 1px', 'padding-right: 2px', 'border-left: 1px solid', 'border-top-right-radius: 4px', 'left: 0', 'float: left', 'text-align: right'];
        for (const sample of caught) assert.ok(PHYSICAL.some((re) => re.test(sample)), sample);
        for (const ok of ['margin-inline-start: 1px', 'border-inline-end: 1px solid', 'inset-inline-start: 0', 'text-align: start', 'border-end-end-radius: 4px']) {
            assert.ok(!PHYSICAL.some((re) => re.test(ok)), ok);
        }
    });

    it('uses no breakpoint the page does not already have, and no colour literal', () => {
        for (const m of mine.matchAll(/@media \((?:min|max)-width: ([\d.]+)rem\)/g)) {
            assert.ok(['30', '40', '48', '51.999', '52', '62'].includes(m[1]!), `new breakpoint ${m[1]}rem`);
        }
        assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(mine), false, 'a colour literal: tokens only');
    });

    it('the hero headline is sized by the display token, not by an override', () => {
        assert.equal(/\.hero h1\s*\{/.test(css), false, 'no .hero h1 rule');
        assert.match(css, /--lp-display:\s*clamp\(2\.25rem, 1\.35rem \+ 3\.2vw, 3\.75rem\)/);
        assert.match(css, /\n {8}h1 \{[^}]*font-size: var\(--lp-display\)/);
    });
});

describe('landing and pricing — the Monteur and Infographics are founder-only until M8', () => {
    const NOTE_AR = '<p class="band-note">يعمل اليوم على حسابات المؤسس وحدها، ويُتاح لحسابات العملاء قريباً.</p>';
    const NOTE_EN = '<p class="band-note">Running today on the founder\'s accounts only; coming to client accounts.</p>';
    const band = (doc: string, name: string, s: string) => {
        const start = doc.indexOf(`id="${name}-${s}"`);
        return doc.slice(start, doc.indexOf('</section>', start));
    };

    it('each band carries the note, in both languages', () => {
        for (const name of ['monteur', 'infographics']) {
            assert.ok(band(L.ar, name, 'ar').includes(NOTE_AR), `${name}-ar`);
            assert.ok(band(L.en, name, 'en').includes(NOTE_EN), `${name}-en`);
        }
    });

    it('the note comes right after the lede, inside the copy column', () => {
        for (const [doc, s, note] of [[L.ar, 'ar', NOTE_AR], [L.en, 'en', NOTE_EN]] as const) {
            for (const name of ['monteur', 'infographics']) {
                const b = band(doc, name, s);
                const lede = b.indexOf('</p>', b.indexOf('<p class="lede">')) + '</p>'.length;
                assert.equal(b.slice(lede).trimStart().startsWith(note), true, `${name}-${s}`);
            }
        }
    });

    it("the Monteur's lede says it runs on a Mac, not on the reader's own computer", () => {
        assert.ok(words(band(L.ar, 'monteur', 'ar')).includes('فيستمع إليه المونتير على جهاز ماك'));
        assert.ok(words(band(L.en, 'monteur', 'en')).includes('The Monteur listens to it on a Mac'));
        assert.equal(/على جهازك/.test(words(band(L.ar, 'monteur', 'ar'))), false);
        assert.equal(/on your computer/.test(words(band(L.en, 'monteur', 'en'))), false);
    });

    it('both requirement rows say so too, in the reviewed words', () => {
        const rows = (doc: string) =>
            [...doc.matchAll(/<li>\s*<h3>(?:المونتير|الإنفوجرافيك|Monteur|Infographics)<\/h3>[\s\S]*?<\/li>/g)].map((m) => words(m[0]));
        for (const doc of [L.ar, L.en]) {
            const found = rows(doc);
            assert.equal(found.length, 2);
            for (const row of found) assert.ok(/حسابات المؤسس وحدها|founder's accounts only/.test(row), row);
        }
        assert.ok(words(L.ar).includes('يقصّ ريلز بمقاس 9:16، وفي الوضع الافتراضي ينتظر كلٌّ منها اعتمادك قبل جدولته. ويعمل اليوم على حسابات المؤسس وحدها.'));
        assert.ok(words(L.en).includes("Cuts reels at 9:16; by default, each one waits for your approval before it is scheduled. Running today on the founder's accounts only."));
        assert.ok(words(L.ar).includes('مقارنات متحرّكة مع نصّها. يعمل اليوم على حسابات المؤسس وحدها'));
        assert.ok(words(L.en).includes("Animated comparisons with their caption. Running today on the founder's accounts only"));
    });

    it('the pricing lede does not offer the Monteur', () => {
        assert.ok(words(P.ar).includes('خدمة مُدارة: نربط حساباتك، ونُعِدّ معك الحملات والاستوديو، ونتابع النشر.'));
        assert.ok(words(P.en).includes('A managed service: we connect your accounts, set up campaigns and the Studio with you, and watch the publishing.'));
        const lede = (doc: string) => /<p class="lede">[\s\S]*?<\/p>/.exec(doc)![0];
        assert.equal(/المونتير|Monteur/.test(lede(P.ar) + lede(P.en)), false);
    });

    it('the bands use the reviewed wording: "design" not "theme", the reel title and caption, the default-approval receipt', () => {
        assert.ok(words(L.ar).includes('ويُرسم بتصميم داكن أو فاتح'));
        assert.ok(words(L.ar).includes('تصميم داكن أو فاتح'));
        assert.equal(/ثيم/.test(noComments(landing)), false);
        assert.ok(words(L.ar).includes('مع عنوان وغلاف ونصٍّ مكتوب يتبع الكلام كلمةً كلمة'));
        assert.ok(L.ar.includes('ونصٌّ مكتوب في أسفله تُضاء فيه الكلمة الجارية'), 'the picture\'s label says "text", not "translation"');
        assert.ok(words(L.ar).includes('لماذا يغادر المشاهد في الثواني الأولى؟'));
        assert.ok(words(L.ar).includes('ابدأ بسؤال، لا بمقدّمة'));
        assert.ok(words(L.en).includes('Why do viewers leave in the first seconds?'));
        assert.ok(words(L.ar).includes('ينتظر كل ريل اعتمادك افتراضياً'));
        assert.ok(words(L.en).includes('Each reel waits for your approval by default'));
    });
});

describe('landing and pricing — nothing says every plan has every feature', () => {
    it('tiers and plan lines say "open to client accounts"', () => {
        const tiers = (doc: string) =>
            [...doc.matchAll(/<li>(?:كل الميزات المتاحة لحسابات العملاء، بلا استثناء|Every feature open to client accounts, without exception)<\/li>/g)].length;
        assert.equal(tiers(P.ar), 3);
        assert.equal(tiers(P.en), 3);
        assert.ok(words(L.ar).includes('في كل باقة كل ما يُتاح لحسابات العملاء'));
        assert.ok(words(L.en).includes('every plan has everything open to client accounts'));
        assert.ok(words(L.ar).includes('في كل باقة كل الميزات المتاحة لحسابات العملاء؛'));
        assert.ok(words(L.en).includes('Every plan has every feature open to client accounts;'));
    });

    for (const [name, html] of [['landing', landing], ['pricing', pricing]] as const) {
        it(`${name}: no unqualified "every feature in the product" in the visible text`, () => {
            const visible = visibleText(html);
            for (const re of [/(?:كل|جميع) ميزات المنتج/, /كل ما في المنتج/, /Every feature in the product/i, /every plan has all of them/i, /Every plan has every feature(?! open)/i]) {
                assert.equal(re.test(visible), false, `${name}: ${re}`);
            }
        });
    }

    it('pricing: no 24-hour reply-window row, and the table note names the rule that remains', () => {
        for (const doc of [P.ar, P.en]) {
            assert.equal(/نافذة الردّ|reply window|24 ساعة من آخر تفاعل|24 hours from that person/i.test(words(doc)), false);
        }
        assert.ok(words(P.ar).includes('وحدّ الرسالة الواحدة للشخص كل 24 ساعة'));
        assert.ok(words(P.en).includes('the one-message-per-person-per-24-hours rule'));
        assert.equal(/نافذة الـ 24|24-hour window/.test(words(P.ar) + words(P.en)), false);
        // The one-message-per-person row stays: it is enforced (canDmRecipient).
        assert.ok(P.ar.includes('رسالة آلية واحدة لكل شخص خلال 24 ساعة') && P.en.includes('One automated DM per person per 24 hours'));
    });
});

describe('landing and pricing — "does anything go out without me seeing it" tells the whole truth about campaigns', () => {
    const AR = 'أمّا الحملة فتعمل وحدها: الرسالة الخاصة والردّ العام نصّان كتبتهما أنت، وإن تعذّر إرسال الرسالة الخاصة نُشر مكانها ردٌّ عامّ قصير بنصٍّ ثابت.';
    const EN = "A campaign does run on its own: the private message and the public reply are text you wrote, and if the private message can't be delivered, a short fixed public reply goes out instead.";

    it('says so on both pages, in both languages, and the old sentence is gone', () => {
        for (const [doc, text] of [[L.ar, AR], [L.en, EN], [P.ar, AR], [P.en, EN]] as const) {
            assert.ok(words(doc).includes(text), text.slice(0, 40));
        }
        for (const doc of [L.ar, L.en, P.ar, P.en]) {
            assert.equal(/رسالة الحملة فتُرسَل وحدها|campaign's message does go out/.test(words(doc)), false);
        }
    });

    it('the self-serve answer is "No", not "Not yet"', () => {
        assert.ok(words(L.ar).includes('لا. ميتا تمنح الأذونات التي يحتاجها البرنامج حساباً حساباً'));
        assert.ok(words(L.en).includes('No. Meta grants the permissions this needs account by account'));
        assert.equal(/ليس بعد|Not yet/.test(words(L.ar) + words(L.en)), false);
    });
});

describe('the six public pages — owner rules', () => {
    const PAGES = ['landing', 'pricing', 'privacy', 'terms', 'data-deletion', '404'];
    const FEMALE = /♀|👩|👧|🧕|نورة|Noura/u;

    for (const p of PAGES) {
        it(`${p}: no woman or girl, no female persona, and no mention of Clario`, () => {
            const html = read(`public/${p}.html`);
            assert.equal(FEMALE.test(html), false, `${p}: a female glyph or persona`);
            assert.equal(/clario/i.test(html), false, `${p}: names Clario`);
        });
    }

    it('the scan is not blind: it catches each thing it is meant to', () => {
        for (const sample of ['♀', '👩', '👧', '🧕', 'نورة', 'Noura']) assert.equal(FEMALE.test(`x ${sample} y`), true, sample);
        assert.equal(/clario/i.test('ClarioDR'), true);
    });
});

describe('landing and pricing — exactly one visible inbox disclosure per language', () => {
    // The inbox's send path is parked, so no sentence sells it. The one mention left is the
    // storage disclosure, which matches /privacy: direct-message text is kept so the inbox can
    // show it. More than one means a claim crept back; none means the disclosure was lost.
    const count = (doc: string, re: RegExp) => (words(doc).match(re) ?? []).length;

    it('landing: one in Arabic and one in English, and it is about what is stored', () => {
        assert.equal(count(L.ar, /صندوق/g), 1);
        assert.equal(count(L.en, /\binbox\b/gi), 1);
        assert.ok(words(L.ar).includes('نص الرسائل الخاصة يُحفَظ ليظهر في صندوق الوارد'));
        assert.ok(words(L.en).includes('Direct-message text is stored so it can appear in your inbox'));
    });

    it('pricing: one in Arabic and one in English, and it is about what is stored', () => {
        assert.equal(count(P.ar, /صندوق/g), 1);
        assert.equal(count(P.en, /\binbox\b/gi), 1);
        assert.ok(words(P.ar).includes('نصّ الرسائل الخاصة يُخزَّن ليظهر لك في صندوق الوارد'));
        assert.ok(words(P.en).includes('Direct-message text is stored so it can appear in your inbox'));
    });
});

describe('landing — the diagrams and the real infographic (L9)', () => {
    const rawCss = /<style>[\s\S]*?<\/style>/.exec(landing)![0];
    const strip = (c: string) => c.replace(/\/\*[\s\S]*?\*\//g, '');
    /** This change's CSS, from the comment that opens it to the next section's, comments removed. */
    const L9 = strip(
        rawCss.slice(
            rawCss.lastIndexOf('/*', rawCss.indexOf('Diagrams, and the real infographic (L9)')),
            rawCss.indexOf('/* ─── Security and privacy')
        )
    );
    const SECTIONS = [['ar', L.ar], ['en', L.en]] as const;

    /** The text between a `{` and its matching `}`. */
    function blockAt(src: string, open: number): string {
        let depth = 0;
        for (let i = open; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
        }
        throw new Error('unbalanced braces');
    }
    /** The bodies of every `@media <query> { … }` in `src`. */
    function mediaBlocks(src: string, query: string): string[] {
        const out: string[] = [];
        for (let at = src.indexOf(`@media ${query}`); at >= 0; at = src.indexOf(`@media ${query}`, at + 1)) {
            out.push(blockAt(src, src.indexOf('{', at)));
        }
        return out;
    }
    /** One element by id, from its opening tag to its closing one. */
    function element(doc: string, id: string, tag = 'figure'): string {
        const at = doc.indexOf(`id="${id}"`);
        assert.ok(at > 0, `#${id} is in the document`);
        const start = doc.lastIndexOf(`<${tag}`, at);
        return doc.slice(start, doc.indexOf(`</${tag}>`, at) + tag.length + 3);
    }

    const FLOWS = { 'flow-dm': 4, 'flow-studio': 5, 'flow-monteur': 6 } as const;

    describe('the ids, the places and the shape', () => {
        it('every diagram, and the real infographic, is in both languages, once, with a label and a caption', () => {
            for (const [s, doc] of SECTIONS) {
                for (const id of ['flow-dm', 'flow-studio', 'flow-monteur', 'pmap', 'infographic-real']) {
                    assert.equal((doc.match(new RegExp(`\\sid="${id}-${s}"`, 'g')) ?? []).length, 1, `${id}-${s}`);
                }
                for (const id of Object.keys(FLOWS)) {
                    const fig = element(doc, `${id}-${s}`);
                    assert.ok(fig.startsWith(`<figure class="flow ${id}`), `${id}-${s} is a .flow figure`);
                    assert.ok(fig.includes(`aria-labelledby="${id}-cap-${s}"`), `${id}-${s} is named by its caption`);
                    assert.ok(fig.includes(`<figcaption id="${id}-cap-${s}">`), `${id}-${s} has the caption it names`);
                }
            }
            for (const [pat, n] of [[/<figure class="flow /g, 3], [/<table class="pmap"/g, 1], [/<figure class="card infovid"/g, 1]] as const) {
                assert.equal((L.ar.match(pat) ?? []).length, n, String(pat));
                assert.equal((L.en.match(pat) ?? []).length, n, String(pat));
            }
        });

        it('each sits where the spec puts it, and the Monteur and Infographics bands stay free of images and video', () => {
            for (const [s, doc] of SECTIONS) {
                const at = (marker: string, from = 0) => {
                    const i = doc.indexOf(marker, from);
                    assert.ok(i >= 0, `${marker} (${s})`);
                    return i;
                };
                // D1 in "what happens when someone comments", before its three beats
                const how = at(`id="how-it-works-${s}"`);
                assert.ok(at(`id="flow-dm-${s}"`, how) < at('<ol class="loop">', how), `flow-dm-${s} comes before the loop`);
                // D2 in "how the Studio works", before its three steps
                const studio = at(`id="studio-how-${s}"`);
                assert.ok(at(`id="flow-studio-${s}"`, studio) < at('<ol class="loop studio-steps">', studio), `flow-studio-${s} comes before the steps`);
                // D3 in the Monteur band, after its grid, inline SVG only
                const monteur = at(`id="monteur-${s}"`);
                const d3 = at(`id="flow-monteur-${s}"`, monteur);
                assert.ok(d3 > at('</aside>', monteur) && d3 < at('</section>', monteur), `flow-monteur-${s} is in the Monteur band, after the grid`);
                const d3Html = element(doc, `flow-monteur-${s}`);
                assert.ok(d3Html.includes('<svg') && !/<img\b|url\(/.test(d3Html), `flow-monteur-${s} is inline SVG only`);
                // D4 in "platforms", before the requirement rows
                const platforms = at(`id="platforms-${s}"`);
                assert.ok(at(`id="pmap-${s}"`, platforms) < at('<ul class="card reqs">', platforms), `pmap-${s} comes before the rows`);
                // the real infographic in the samples band: after the one carousel, before the covers, and NOT in the Infographics band
                const samples = at(`id="samples-${s}"`);
                const real = at(`id="infographic-real-${s}"`, samples);
                assert.ok(real > at('<div class="card seq">', samples) && real < at('<div class="covers">', samples), `infographic-real-${s} sits between the carousel and the covers`);
                const infographics = at(`id="infographics-${s}"`);
                assert.ok(!doc.slice(infographics, at('</section>', infographics)).includes('<video'), 'the Infographics band holds no video');
            }
        });

        it('a flow has the nodes it names and one arrow before each node but the first, in both languages', () => {
            for (const [s, doc] of SECTIONS) {
                for (const [id, nodes] of Object.entries(FLOWS)) {
                    const fig = element(doc, `${id}-${s}`);
                    assert.equal((fig.match(/<li class="flow-node">/g) ?? []).length, nodes, `${id}-${s}: nodes`);
                    assert.equal((fig.match(/<li class="flow-node"><svg class="flow-arrow"/g) ?? []).length, nodes - 1, `${id}-${s}: arrows`);
                    assert.equal(/<ol class="flow-steps">\s*<li class="flow-node"><svg class="flow-arrow"/.test(fig), false, `${id}-${s}: the first node has none`);
                }
            }
        });

        it('flow-long is on the two long flows and only there: the short one turns into a row earlier', () => {
            for (const [s, doc] of SECTIONS) {
                assert.ok(element(doc, `flow-studio-${s}`).startsWith('<figure class="flow flow-studio flow-long"'));
                assert.ok(element(doc, `flow-monteur-${s}`).startsWith('<figure class="flow flow-monteur flow-long"'));
                assert.ok(element(doc, `flow-dm-${s}`).startsWith('<figure class="flow flow-dm"'));
            }
        });
    });

    describe('what each diagram says', () => {
        const AR = {
            'flow-dm': ['«كم السعر؟»', 'تطابق كلمة الحملة', 'رسالتك على الخاص', 'ردّ عام (اختياري)', 'إعجاب (يُحاوَل)', 'مرة لكل شخص كل 24 ساعة · 180 في الساعة لكل حساب', 'على إنستجرام وفيسبوك وحدهما'],
            'flow-studio': ['درس', 'ما يشرحه ولقطاته', 'كاروسيل 4:5 و9:16', 'تراجعه', 'يُجدوَل', 'يُجدوَل أو ينتظر في طابور حتى موافقة تيك توك'],
            'flow-monteur': ['فيديو طويل في مجلده', 'يستمع إليه على ماك', 'لحظات تبدأ بخطّاف', 'ريل 9:16: عنوان، نصّ، غلاف', 'اعتمادك', 'مواعيدك على المنصّات التي تختارها', 'مسودّة / أنا فقط', 'يعمل اليوم على حسابات المؤسس وحدها'],
        };
        const EN = {
            'flow-dm': ['“How much is the price?”', 'Campaign keyword matched', 'Your private message', 'Public reply (optional)', 'Like (attempted)', 'Once per person every 24 hours · 180 an hour per account', 'On Instagram and Facebook only'],
            'flow-studio': ['Lesson', 'What it teaches, and its frames', 'Carousel 4:5 and 9:16', 'You review it', 'Scheduled', 'Scheduled, or held in a queue until TikTok approves the app'],
            'flow-monteur': ['A long video in its folder', 'Listened to on a Mac', 'Moments that open with a hook', 'A 9:16 reel: title, captions, cover', 'Your approval', 'Your slots, on the platforms you choose', 'Draft / Only me', "Running today on the founder's accounts only"],
        };

        it("uses the spec's node texts, in Arabic and in English", () => {
            for (const [texts, doc, s] of [[AR, L.ar, 'ar'], [EN, L.en, 'en']] as const) {
                for (const [id, lines] of Object.entries(texts)) {
                    const said = words(element(doc, `${id}-${s}`));
                    for (const line of lines) assert.ok(said.includes(line), `${id}-${s}: "${line}"`);
                }
            }
        });

        it('D1: the keyword node lights السعر / price, and the comment it came from contains it, word-delimited', () => {
            assert.ok(element(L.ar, 'flow-dm-ar').includes('<span class="flow-s"><span class="kw">السعر</span></span>'));
            assert.ok(element(L.en, 'flow-dm-en').includes('<span class="flow-s"><span class="kw">price</span></span>'));
            assert.match(words(element(L.ar, 'flow-dm-ar')), /«كم السعر[ ؟?،.]/);
            assert.match(words(element(L.en, 'flow-dm-en')), /“How much is the price[ ?,.]/);
            // The highlighter belongs to the keyword node alone: one .kw in the diagram.
            for (const [s, doc] of SECTIONS) assert.equal((element(doc, `flow-dm-${s}`).match(/class="kw"/g) ?? []).length, 1, s);
        });

        it('D1: the limits ribbon quotes the two numbers the page states as fixed', () => {
            for (const [s, doc] of SECTIONS) {
                const ribbon = /<p class="flow-limits">([^<]*)<\/p>/.exec(element(doc, `flow-dm-${s}`))![1]!;
                const fixed = [...(/<dl class="figures">[\s\S]*?<\/dl>/.exec(doc)![0]).matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]!);
                assert.deepEqual(fixed.slice().sort(), ['180', '24']);
                for (const n of fixed) assert.ok(ribbon.includes(n), `${s}: the ribbon says ${n}`);
            }
        });

        it('the chips name only the platforms each flow reaches: Meta alone for comment-to-DM, and WhatsApp nowhere', () => {
            const glyphs = (fig: string) => [...fig.matchAll(/#plogo-([a-z]+)/g)].map((m) => m[1]!);
            for (const [s, doc] of SECTIONS) {
                assert.deepEqual(glyphs(element(doc, `flow-dm-${s}`)), ['instagram', 'facebook'], `${s}: comment-to-DM is Instagram and Facebook`);
                assert.deepEqual(glyphs(element(doc, `flow-studio-${s}`)), ['instagram', 'facebook', 'tiktok'], `${s}: the Studio posts to Instagram, Facebook and TikTok`);
                assert.deepEqual(glyphs(element(doc, `flow-monteur-${s}`)), ['instagram', 'facebook', 'youtube', 'tiktok'], `${s}: the Monteur's four`);
                assert.deepEqual(glyphs(element(doc, `pmap-${s}`, 'table')), ['instagram', 'facebook', 'tiktok', 'youtube'], `${s}: the map's four rows`);
            }
        });

        it('TikTok is never shown as a plain scheduled post: held, or draft / only me, until TikTok approves the app', () => {
            for (const [s, doc] of SECTIONS) {
                const tiktokNote = (fig: string) => /#plogo-tiktok"\/><\/svg>[^<]*<\/span><\/span><span class="flow-s">([^<]*)<\/span>/.exec(fig)![1]!;
                const studio = tiktokNote(element(doc, `flow-studio-${s}`));
                const monteur = tiktokNote(element(doc, `flow-monteur-${s}`));
                assert.ok(s === 'ar' ? studio.includes('حتى موافقة تيك توك') : studio.includes('until TikTok approves the app'), `${s}: ${studio}`);
                assert.equal(monteur, s === 'ar' ? 'مسودّة / أنا فقط' : 'Draft / Only me');
            }
        });

        it('D3 keeps the founder-only note: in the band, and under the diagram', () => {
            assert.ok(words(element(L.ar, 'flow-monteur-ar')).includes('حسابات المؤسس وحدها'));
            assert.ok(words(element(L.en, 'flow-monteur-en')).includes("founder's accounts only"));
            const band = (doc: string, s: string) => doc.slice(doc.indexOf(`id="monteur-${s}"`), doc.indexOf('</section>', doc.indexOf(`id="monteur-${s}"`)));
            assert.ok(band(L.ar, 'ar').includes('<p class="band-note">'));
            assert.ok(band(L.en, 'en').includes('<p class="band-note">'));
        });

        it('says nothing the page forbids: no AI reply, no person, no emoji', () => {
            for (const [s, doc] of SECTIONS) {
                for (const id of ['flow-dm', 'flow-studio', 'flow-monteur', 'pmap', 'infographic-real']) {
                    const text = words(element(doc, `${id}-${s}`, id === 'pmap' ? 'table' : 'figure'));
                    assert.equal(/\bAI\b|الذكاء الاصطناعي|\p{Extended_Pictographic}/u.test(text), false, `${id}-${s}`);
                }
            }
        });
    });

    describe('D4: the platform map is a real table, and every ✓ is true', () => {
        const COLUMNS = ['dm', 'post', 'carousel', 'video', 'insights'] as const;
        const HEADS = {
            ar: ['المنصّة', 'من التعليق إلى الرسالة', 'النشر', 'الكاروسيل', 'الفيديو', 'الأداء'],
            en: ['Platform', 'Comment to DM', 'Posting', 'Carousel', 'Video', 'Performance'],
        };
        /** What a platform's "what works there" paragraph must say for a cell to carry a ✓ or a note. */
        const BACKED: Record<'ar' | 'en', Record<(typeof COLUMNS)[number], Record<string, RegExp[]>>> = {
            ar: {
                dm: { instagram: [/من التعليق إلى الرسالة الخاصة/], facebook: [/من تعليقات الصفحة إلى الرسالة الخاصة/] },
                post: { instagram: [/جدولة/], facebook: [/جدولة/], tiktok: [/النشر وحده/, /أنا فقط/, /مسودّ/], youtube: [/الرفع وحده/] },
                carousel: { instagram: [/الكاروسيل/], facebook: [/الكاروسيل/], tiktok: [/كاروسيل صور/] },
                video: { instagram: [/الريلز/], facebook: [/الفيديو/], tiktok: [/فيديو/], youtube: [/Shorts/] },
                insights: { instagram: [/أداء المنشورات/] },
            },
            en: {
                dm: { instagram: [/Comment-to-DM/], facebook: [/Comment-to-DM/] },
                post: { instagram: [/scheduled/], facebook: [/scheduled/], tiktok: [/Publishing only/, /Only me/, /drafts/], youtube: [/Uploading only/] },
                carousel: { instagram: [/carousels/], facebook: [/carousels/], tiktok: [/photo carousels/] },
                video: { instagram: [/reels/], facebook: [/video/], tiktok: [/video/], youtube: [/Shorts/] },
                insights: { instagram: [/post performance/] },
            },
        };
        /** What a dash must not find in the row: the column's own subject. (Posting and video have no dash.) */
        const ABSENT: Record<'ar' | 'en', Partial<Record<(typeof COLUMNS)[number], RegExp>>> = {
            ar: { dm: /إلى الرسالة الخاصة/, carousel: /كاروسيل/, insights: /أداء المنشورات/ },
            en: { dm: /Comment-to-DM/, carousel: /carousel/i, insights: /post performance/ },
        };
        /** The one ✓ (y), note (p) or dash (x) each cell must be: the spec's table. */
        const KINDS = { instagram: 'yyyyy', facebook: 'yyyyx', tiktok: 'xpyyx', youtube: 'xpxyx' } as const;

        function parse(doc: string, s: 'ar' | 'en') {
            const table = element(doc, `pmap-${s}`, 'table');
            const heads = [...table.matchAll(/<th scope="col" role="columnheader">([^<]*)<\/th>/g)].map((m) => m[1]!);
            const rows = [...table.matchAll(/<tr role="row"><th scope="row" role="rowheader">([\s\S]*?)<\/th>([\s\S]*?)<\/tr>/g)].map((m) => ({
                id: /#plogo-([a-z]+)/.exec(m[1]!)![1]!,
                cells: [...m[2]!.matchAll(/<td role="cell" class="([ypx])" data-th="([^"]*)">([\s\S]*?)<\/td>/g)].map((c) => ({ kind: c[1]!, th: c[2]!, text: words(c[3]!).trim() })),
            }));
            return { table, heads, rows };
        }
        /** The "what works there" paragraph of one platform's requirements row. */
        function worksThere(doc: string, id: string): string {
            const list = /<ul class="card reqs">[\s\S]*?<\/ul>/.exec(doc)![0];
            const li = [...list.matchAll(/<li[^>]*>\s*<h3>([\s\S]*?)<\/h3>[\s\S]*?<\/li>/g)].find((m) => m[1]!.includes(`#plogo-${id}`));
            assert.ok(li, `a requirements row for ${id}`);
            return words([...li[0].matchAll(/<p class="req-v">([\s\S]*?)<\/p>/g)][1]![1]!);
        }

        for (const [s, doc] of SECTIONS) {
            it(`${s}: <table> with a caption, a head, four platform rows and five columns, each cell naming its column`, () => {
                const { table, heads, rows } = parse(doc, s);
                assert.ok(table.startsWith('<table class="pmap"'));
                assert.ok(/<caption>[^<]+<\/caption>\s*<thead>[\s\S]*<\/thead>\s*<tbody>[\s\S]*<\/tbody>/.test(table));
                assert.deepEqual(heads, HEADS[s]);
                assert.deepEqual(rows.map((r) => r.id), ['instagram', 'facebook', 'tiktok', 'youtube']);
                for (const row of rows) {
                    assert.equal(row.cells.length, 5, row.id);
                    assert.deepEqual(row.cells.map((c) => c.th), HEADS[s].slice(1), `${row.id}: data-th repeats the column head`);
                    assert.equal(row.cells.map((c) => c.kind).join(''), KINDS[row.id as keyof typeof KINDS], `${row.id}: the spec's table`);
                }
                // A ✓ has a word a screen reader says, and so has a dash.
                assert.equal((table.match(/class="y"[^>]*>[\s\S]*?<\/td>/g) ?? []).every((c) => words(c.replace(/^[^>]*>/, '')).trim().length > 0), true);
                assert.equal((table.match(/class="x"[^>]*>[\s\S]*?<\/td>/g) ?? []).every((c) => c.includes('aria-hidden="true">—</span><span class="sr-only">')), true);
            });

            it(`${s}: every ✓ and every note is backed by a phrase in that platform's row, and no dash is`, () => {
                const { rows } = parse(doc, s);
                let claims = 0;
                for (const row of rows) {
                    const said = worksThere(doc, row.id);
                    row.cells.forEach((cell, i) => {
                        const col = COLUMNS[i]!;
                        if (cell.kind === 'x') {
                            const subject = ABSENT[s][col];
                            assert.ok(subject, `${s} ${row.id}/${col}: only dm, carousel and insights have dashes`);
                            assert.equal(subject.test(said), false, `${s} ${row.id}/${col}: a dash, but the row speaks of it`);
                        } else {
                            const phrases = BACKED[s][col][row.id] ?? [];
                            assert.ok(phrases.length > 0, `${s} ${row.id}/${col}: a ✓ with no phrase to back it`);
                            for (const re of phrases) assert.match(said, re, `${s} ${row.id}/${col}`);
                            claims++;
                        }
                    });
                }
                assert.equal(claims, 14, 'the cells that claim something in the spec: 5 + 4 + 3 + 2');
            });
        }

        it('the same ✓, notes and dashes in both languages', () => {
            assert.deepEqual(parse(L.ar, 'ar').rows.map((r) => r.cells.map((c) => c.kind)), parse(L.en, 'en').rows.map((r) => r.cells.map((c) => c.kind)));
        });

        it('the guard is not blind: a ✓ the row does not back, and a dash it contradicts, are both caught', () => {
            const tiktok = 'Publishing only: video and photo carousels. No comments or messages on TikTok.';
            assert.equal(BACKED.en.dm.instagram![0]!.test(tiktok), false, 'TikTok has no comment-to-DM');
            assert.equal(BACKED.en.insights.instagram![0]!.test(tiktok), false, 'TikTok has no performance');
            assert.equal(BACKED.en.carousel.tiktok![0]!.test(tiktok), true);
            assert.equal(ABSENT.en.dm!.test('Comment-to-DM campaigns, scheduled photos'), true, 'a dash beside that sentence would be caught');
            assert.equal(ABSENT.ar.insights!.test('وقراءة أداء المنشورات'), true);
        });
    });

    describe('the CSS: a column first, the packet only under no-preference, arrows mirrored and logos not', () => {
        const num = (re: RegExp) => {
            const m = re.exec(L9);
            assert.ok(m, String(re));
            return Number(m[1]);
        };

        it('every animation is inside prefers-reduced-motion: no-preference, once, and the finished state is the default', () => {
            const calm = mediaBlocks(L9, '(prefers-reduced-motion: no-preference)');
            assert.equal(calm.length, 1, 'one block of motion');
            const outside = L9.replace(calm[0]!, '').replace(/@keyframes [\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
            assert.equal(/animation[\w-]*\s*:/.test(outside), false, 'no animation outside the block');
            assert.equal(/\.is-inview/.test(outside), false, '.is-inview does nothing outside it');
            // the shorthand's names, durations and iteration counts
            const uses = [...calm[0]!.matchAll(/(?<![-\w])animation\s*:\s*([^;]+);/g)].map((m) => m[1]!.trim());
            assert.equal(uses.length, 2, 'the hop and the receipt');
            for (const use of uses) assert.ok(Number(/\s(\d+)$/.exec(use)![1]) <= 3, `at most 3 iterations: ${use}`);
            assert.match(uses[0]!, /^flow-hop 1\.2s var\(--ease-standard\) 1$/);
            assert.match(uses[1]!, /^flow-receipt var\(--motion-base\) var\(--ease-exit\) calc\(\(var\(--flow-hops\) - 1\) \* var\(--flow-step\) \+ 0\.9s\) 1$/);
            // the finished state: the packet is invisible until it runs, and nothing else starts hidden
            const packet = [...outside.matchAll(/\.flow-node \+ \.flow-node::after \{[^}]*\}/g)].map((m) => m[0]).find((r) => r.includes('--flow-pkt'))!;
            assert.ok(packet, 'the packet rule');
            assert.match(packet, /opacity:\s*0\b/);
            assert.match(packet, /background:\s*var\(--accent\)/);
            assert.match(packet, /inline-size:\s*var\(--flow-pkt\)/);
            assert.match(packet, /pointer-events:\s*none/);
            assert.equal(num(/--flow-pkt:\s*(\d+)px/), 6, 'the packet is 6px');
            assert.equal(/opacity:\s*0\b/.test(outside.replace(packet, '')), false, 'nothing else starts invisible');
        });

        it("one flow lasts at most 5s, receipt included, and each flow's hop count is its connector count", () => {
            const stepOf = (id: string) => {
                const own = new RegExp(`\\.${id} \\{[^}]*--flow-step:\\s*([\\d.]+)s`).exec(L9);
                return own ? Number(own[1]) : num(/\.flow \{[^}]*--flow-step:\s*([\d.]+)s/);
            };
            const HOP = 1.2;
            for (const [id, nodes] of Object.entries(FLOWS)) {
                const hops = num(new RegExp(`\\.${id} \\{[^}]*--flow-hops:\\s*(\\d+)`));
                assert.equal(hops, nodes - 1, `${id}: --flow-hops is the number of connectors`);
                const step = stepOf(id);
                const lastLands = (hops - 1) * step + HOP;
                const receiptEnds = (hops - 1) * step + 0.9 + 0.2; // starts at 0.9s of the last hop, runs 200ms
                assert.ok(lastLands <= 5, `${id}: the last packet lands at ${lastLands}s`);
                assert.ok(receiptEnds <= lastLands + 0.001, `${id}: the receipt ends at ${receiptEnds}s, with the last packet`);
            }
            // the hops after the first start at multiples of the step
            for (const [n, k] of [[3, ''], [4, ' * 2'], [5, ' * 3'], [6, ' * 4']] as const) {
                const want = k ? `calc(var(--flow-step)${k})` : 'var(--flow-step)';
                assert.ok(L9.includes(`.flow.is-inview .flow-node:nth-child(${n})::after { animation-delay: ${want}; }`), `delay of hop ${n - 1}`);
            }
        });

        it('a flow is a column by default; only min-width queries make it a row: 48rem for the short one, 62rem for the long', () => {
            assert.match(/\.flow-steps \{[^}]*\}/.exec(L9)![0], /--h:\s*0;/);
            const rows = (query: string) => mediaBlocks(L9, query).filter((b) => /--h:\s*1/.test(b));
            assert.equal(rows('(min-width: 48rem)').length, 1);
            assert.ok(/\.flow:not\(\.flow-long\) \.flow-steps/.test(rows('(min-width: 48rem)')[0]!));
            assert.equal(rows('(min-width: 62rem)').length, 1);
            assert.ok(/\.flow-long \.flow-steps/.test(rows('(min-width: 62rem)')[0]!));
            for (const q of ['(max-width: 30rem)', '(max-width: 40rem)']) assert.equal(rows(q).length, 0, `${q} never makes a row`);
        });

        it('arrows mirror under :dir(rtl) in a row and point down in a column; nothing of this change flips a logo', () => {
            assert.match(/\n\s*\.flow-arrow \{[^}]*\}/.exec(L9)![0], /transform:\s*rotate\(90deg\)/, 'a column: down, in both directions');
            for (const sel of ['.flow:not(.flow-long):dir(rtl) .flow-arrow', '.flow-long:dir(rtl) .flow-arrow']) {
                const at = L9.indexOf(`${sel} {`);
                assert.ok(at >= 0, sel);
                assert.match(L9.slice(at, L9.indexOf('}', at)), /transform:\s*scaleX\(-1\)/, sel);
            }
            for (const m of L9.matchAll(/([^{}]*\.plogo[^{}]*)\{([^}]*)\}/g)) {
                assert.equal(/transform|:dir\(|direction/.test(m[1]! + m[2]!), false, m[1]!.trim());
            }
        });

        it('the platform map is a card per row under 40rem: block display, a label from data-th, the head out of sight', () => {
            const [phone] = mediaBlocks(L9, '(max-width: 40rem)');
            assert.ok(phone, 'a block for 40rem');
            assert.match(phone, /\.pmap, \.pmap thead, \.pmap tbody, \.pmap tr, \.pmap th, \.pmap td \{ display: block; \}/);
            assert.match(phone, /\.pmap td::before \{[^}]*content:\s*attr\(data-th\)/);
            assert.match(phone, /\.pmap thead \{[^}]*clip-path:\s*inset\(50%\)/);
            assert.match(phone, /\.pmap caption \{ display: block; \}/);
        });

        it('the video box is 4:5 and 22rem, and 18rem on phones', () => {
            const box = /\.infovid video \{[^}]*\}/.exec(L9)![0];
            assert.match(box, /aspect-ratio:\s*4 \/ 5/);
            assert.match(box, /max-inline-size:\s*22rem/);
            const [phone] = mediaBlocks(L9, '(max-width: 30rem)');
            assert.match(phone!, /\.infovid video \{ max-inline-size: 18rem; \}/);
        });
    });

    describe('the real infographic: one <video> in the samples band, two cuts, a caption that links to the post', () => {
        const REEL = 'https://www.instagram.com/reel/DeZqk8-D-X3/';
        const attrs = (tag: string) => new Map([...tag.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g)].map((m) => [m[1]!, m[2] ?? '']));

        for (const [s, doc] of SECTIONS) {
            it(`${s}: the video has exactly the attributes the spec lists, the dark cut as the default, and no autoplay`, () => {
                const fig = element(doc, `infographic-real-${s}`);
                const a = attrs(/<video\b([^>]*)><\/video>/.exec(fig)![1]!);
                assert.deepEqual([...a.keys()].sort(), ['aria-label', 'controls', 'height', 'loop', 'muted', 'playsinline', 'poster', 'preload', 'src', 'width']);
                assert.equal(a.get('width'), '720');
                assert.equal(a.get('height'), '900');
                assert.equal(a.get('preload'), 'none');
                assert.equal(a.get('poster'), '/samples/chat-vs-agent-info-dark.webp');
                assert.equal(a.get('src'), '/samples/chat-vs-agent-info-dark.mp4');
                assert.ok(a.get('aria-label')!.length > 60, 'a real description, not a label');
                assert.equal(/[\u0600-\u06FF]/.test(a.get('aria-label')!), s === 'ar', `${s}: in the page's language`);
                assert.equal((fig.match(/<video\b/g) ?? []).length, 1, 'one video');
                assert.equal(/autoplay/i.test(fig), false);
            });

            it(`${s}: the caption says it was posted on Instagram and links to the reel; the Infographics band links here`, () => {
                const fig = element(doc, `infographic-real-${s}`);
                const text = s === 'ar' ? 'كما نُشر على إنستجرام' : 'As posted on Instagram';
                assert.ok(fig.includes(`<figcaption><a href="${REEL}" target="_blank" rel="noopener noreferrer">${text}</a></figcaption>`));
                const label = s === 'ar' ? 'شاهده متحرّكاً' : 'Watch it animated';
                const from = doc.indexOf(`id="infographics-${s}"`);
                const band = doc.slice(from, doc.indexOf('</section>', from));
                assert.ok(band.includes(`<p class="watch"><a href="#infographic-real-${s}">${label}</a></p>`));
            });
        }

        it('one IntersectionObserver serves the diagrams and the video, and it is never created under reduced motion', () => {
            const script = [...landing.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).find((x) => x.includes('is-inview'))!;
            assert.ok(script, 'the L9 script is in the page');
            assert.equal((landing.match(/new IntersectionObserver\(/g) ?? []).length, 1, 'one observer on the whole page');
            const gate = script.indexOf("if (!calm || !('IntersectionObserver' in window)) return;");
            assert.ok(gate > 0 && gate < script.indexOf('new IntersectionObserver('), 'the gate comes first');
            assert.match(script, /var calm = !!window\.matchMedia && window\.matchMedia\('\(prefers-reduced-motion: no-preference\)'\)\.matches;/);
            assert.match(script, /threshold: \[0\.2, 0\.5\]/);
            assert.match(script, /e\.intersectionRatio >= 0\.5/, 'the video plays from half in view');
            assert.match(script, /classList\.add\('is-inview'\)/);
            assert.equal((script.match(/\.play\(\)/g) ?? []).length, 1, 'play() is called from one place, which is only reached past the gate');
            // the theme: data-theme if something pins one, the OS preference otherwise; dark stays the default
            assert.match(script, /getAttribute\('data-theme'\)/);
            assert.match(script, /matchMedia\('\(prefers-color-scheme: light\)'\)/);
            assert.match(script, /var TONE = \/-\(\?:dark\|light\)\\\.\//);
        });
    });

    describe('the files behind it', () => {
        const KB = 1000;
        const size = (buf: Buffer) => {
            const i = buf.indexOf('avc1', buf.indexOf('moov'));
            return [buf.readUInt16BE(i + 4 + 24), buf.readUInt16BE(i + 4 + 26)];
        };

        for (const tone of ['dark', 'light']) {
            it(`chat-vs-agent-info-${tone}: an H.264 MP4 of 720x900 under 600 KB, with no audio and its index up front`, () => {
                const path = `public/samples/chat-vs-agent-info-${tone}.mp4`;
                const buf = readFileSync(path);
                assert.ok(statSync(path).size <= 600 * KB, `${statSync(path).size} bytes`);
                assert.equal(buf.subarray(4, 8).toString(), 'ftyp');
                assert.ok(buf.indexOf('moov') > 0 && buf.indexOf('moov') < buf.indexOf('mdat'), 'faststart: moov before mdat');
                assert.equal(buf.includes('soun'), false, 'no audio track');
                assert.ok(buf.includes('vide'));
                assert.deepEqual(size(buf), [720, 900]);
            });

            it(`chat-vs-agent-info-${tone}: a WebP poster of 720x900 under 45 KB`, () => {
                const path = `public/samples/chat-vs-agent-info-${tone}.webp`;
                const buf = readFileSync(path);
                assert.ok(statSync(path).size <= 45 * KB, `${statSync(path).size} bytes`);
                assert.equal(buf.subarray(0, 4).toString() + buf.subarray(8, 12).toString(), 'RIFFWEBP');
                assert.equal(buf.subarray(12, 16).toString(), 'VP8 ', 'a lossy frame, read as VP8');
                assert.deepEqual([buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff], [720, 900]);
            });
        }

        it('every file the page names under /samples exists, and the dark cut is the only video the markup names', () => {
            const named = new Set([...landing.matchAll(/["'](\/samples\/[a-z0-9-]+\.(?:webp|mp4))["']/g)].map((m) => m[1]!));
            assert.ok(named.size >= 9);
            for (const f of named) assert.ok(statSync(`public${f}`).isFile(), f);
            assert.deepEqual([...named].filter((f) => f.endsWith('.mp4')), ['/samples/chat-vs-agent-info-dark.mp4']);
        });

        it("the diagrams' HTML is under 6 KB gzipped, both languages together", () => {
            const blocks: string[] = [];
            for (const [s, doc] of SECTIONS) {
                for (const id of Object.keys(FLOWS)) blocks.push(element(doc, `${id}-${s}`));
                blocks.push(element(doc, `pmap-${s}`, 'table'));
            }
            const gz = gzipSync(blocks.join('\n'), { level: 9 }).length;
            assert.ok(gz <= 6 * 1024, `${gz} bytes gzipped`);
        });
    });
});

describe('landing — the hero 3D stage (L10)', () => {
    const SECTIONS = [['ar', L.ar], ['en', L.en]] as const;
    const rawCss = /<style>[\s\S]*?<\/style>/.exec(landing)![0];
    const strip = (c: string) => c.replace(/\/\*[\s\S]*?\*\//g, '');
    const css = strip(rawCss);

    type Comment = { t: string; kw?: string; p: string };
    /** The stage of one language: from its opening tag to the `</div>` right after the card it wraps. */
    function stage(doc: string, s: string): string {
        const at = doc.indexOf(`<div class="hero-stage" id="hero-stage-${s}"`);
        assert.ok(at > 0, `#hero-stage-${s} is in the ${s} document`);
        const card = doc.indexOf('</aside>', at);
        const end = doc.indexOf('</div>', card) + '</div>'.length;
        assert.equal(doc.slice(card + '</aside>'.length, end).trim(), '</div>', 'the card is the last thing in the stage');
        return doc.slice(at, end);
    }
    const cast = (html: string): Comment[] => {
        const raw = /data-hero3d='([^']*)'/.exec(html)![1]!;
        const parsed = JSON.parse(raw) as { comments: Comment[] };
        assert.deepEqual(Object.keys(parsed), ['comments']);
        return parsed.comments;
    };
    /** The flat rules of the page's CSS (media blocks included) whose selector matches, as {sel, body}. */
    function rulesNaming(re: RegExp): Array<{ sel: string; body: string }> {
        const out: Array<{ sel: string; body: string }> = [];
        for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
            const sel = m[1]!.trim().replace(/\s+/g, ' ');
            if (re.test(sel)) out.push({ sel, body: m[2]! });
        }
        return out;
    }
    const exact = (selector: string) => new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')}$`);

    describe('the markup', () => {
        it('each language has one stage, wrapping the hero card, with the poster in front of it in the DOM', () => {
            for (const [s, doc] of SECTIONS) {
                assert.equal((doc.match(/class="hero-stage"/g) ?? []).length, 1, s);
                const html = stage(doc, s);
                assert.equal((html.match(/<aside\b/g) ?? []).length, 1, 'the card, and nothing else with a role');
                assert.ok(html.indexOf('class="stage-poster"') > 0 && html.indexOf('class="stage-poster"') < html.indexOf('<aside'), `${s}: the poster is behind the card`);
                // It is inside the hero's grid, in the card's place, and the hero holds no other section.
                const hero = /<section class="hero"[\s\S]*?<\/section>/.exec(doc)![0];
                assert.ok(hero.includes(`id="hero-stage-${s}"`));
                assert.equal((hero.match(/<section\b/g) ?? []).length, 1, 'no new <section> in the hero');
                // The card keeps its exact class and label: other tests, and screen readers, rely on them.
                assert.match(html, /<aside class="card artifact" aria-label="[^"]+">/);
            }
            assert.ok(stage(L.ar, 'ar').includes('aria-label="مثال: تعليق وما نتج عنه"'));
            assert.ok(stage(L.en, 'en').includes('aria-label="Example: one comment and what it produced"'));
        });

        it('the stage carries its pause labels, in its own language and different from each other', () => {
            for (const [s, doc] of SECTIONS) {
                const tag = /<div class="hero-stage"[^>]*>/.exec(stage(doc, s))![0];
                const pause = /data-pause-label="([^"]+)"/.exec(tag)?.[1];
                const play = /data-play-label="([^"]+)"/.exec(tag)?.[1];
                assert.ok(pause && play && pause !== play, s);
                if (s === 'ar') assert.ok(/^[\u0600-\u06ff ]+$/.test(pause) && /^[\u0600-\u06ff ]+$/.test(play), 'Arabic');
                else assert.ok(/^[A-Za-z ]+$/.test(pause) && /^[A-Za-z ]+$/.test(play), 'English');
            }
        });

        it('the toggle the loader inserts is one template: a 44px-target button with Lucide pause and play, the icon hidden from screen readers', () => {
            assert.equal((landing.match(/<template id="hero-toggle">/g) ?? []).length, 1);
            const tpl = /<template id="hero-toggle">([\s\S]*?)<\/template>/.exec(landing)![1]!;
            assert.match(tpl, /^<button type="button" class="stage-toggle"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">/);
            assert.ok(tpl.includes('class="i-pause"') && tpl.includes('class="i-play"'), 'both icons: the loader never draws one');
            assert.equal(/aria-label|aria-pressed/.test(tpl), false, "the loader sets the name and the state from the stage's own data attributes");
            // Lucide 0.577.0's pause (two rounded bars) and play (one rounded triangle), as published.
            assert.ok(tpl.includes('<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>'));
            assert.ok(tpl.includes('d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"'));
            const rule = rulesNaming(exact('.stage-toggle'))[0]!.body;
            assert.match(rule, /inline-size:\s*var\(--tap-target\)/);
            assert.match(rule, /block-size:\s*var\(--tap-target\)/);
        });
    });

    describe('the cast (data-hero3d)', () => {
        const casts = { ar: cast(stage(L.ar, 'ar')), en: cast(stage(L.en, 'en')) };

        it('both languages have the same number of comments, on the same platforms, with the same ones lit', () => {
            assert.equal(casts.ar.length, casts.en.length);
            assert.ok(casts.ar.length >= 8, 'enough for the full profile, which shows eight bubbles');
            assert.deepEqual(casts.ar.map((c) => c.p), casts.en.map((c) => c.p));
            assert.deepEqual(casts.ar.map((c) => !!c.kw), casts.en.map((c) => !!c.kw));
        });

        it('only Meta platforms appear, because comment-to-DM is Meta only', () => {
            for (const lang of ['ar', 'en'] as const) {
                for (const c of casts[lang]) assert.ok(c.p === 'instagram' || c.p === 'facebook', `${lang}: ${c.p}`);
                assert.ok(casts[lang].some((c) => c.p === 'instagram') && casts[lang].some((c) => c.p === 'facebook'));
            }
        });

        it('a keyword stands alone in its comment: after a space or the start, before a space or ؟ ? ، . ,', () => {
            for (const lang of ['ar', 'en'] as const) {
                for (const c of casts[lang]) {
                    if (c.kw === undefined) continue;
                    const at = c.t.indexOf(c.kw);
                    assert.ok(at >= 0, `${lang}: "${c.kw}" is in "${c.t}"`);
                    assert.ok(at === 0 || c.t[at - 1] === ' ', `${lang}: "${c.kw}" starts a word in "${c.t}"`);
                    assert.match(c.t[at + c.kw.length] ?? '', /^[ \u061f?\u060c.,]$/, `${lang}: "${c.kw}" is followed by a delimiter in "${c.t}"`);
                    assert.equal(c.t.indexOf(c.kw, at + 1), -1, `${lang}: "${c.kw}" appears once`);
                }
            }
        });

        it('there are comments that match nothing, and the lite profile (the first five) shows both kinds', () => {
            for (const lang of ['ar', 'en'] as const) {
                assert.ok(casts[lang].filter((c) => !c.kw).length >= 2, `${lang}: quiet comments that never light`);
                assert.ok(casts[lang].filter((c) => c.kw).length >= 4);
                assert.ok(casts[lang].slice(0, 5).some((c) => !c.kw) && casts[lang].slice(0, 5).some((c) => c.kw), `${lang}: lite has both kinds`);
            }
        });

        it('has no names and no other fields: comments are speech, with no persona or handle in them', () => {
            for (const lang of ['ar', 'en'] as const) {
                for (const c of casts[lang]) {
                    assert.deepEqual(Object.keys(c).filter((k) => !['t', 'kw', 'p'].includes(k)), [], 'no name, handle or author field');
                    assert.equal(/سالم|Salem|نورة|Noura|@/.test(c.t), false, `${lang}: "${c.t}"`);
                    assert.equal(/\b[A-Z][a-z]+\b/.test(c.t.replace(/^[A-Z][a-z]+/, '')), false, `${lang}: "${c.t}" has a capitalised word after its first, which would be a name`);
                    assert.ok(c.t.length >= 8 && c.t.length <= 28, `${lang}: "${c.t}" fits a bubble`);
                }
            }
        });

        it("the first comment is the card's own: the one the DM answers, with the same keyword lit", () => {
            for (const [s, doc] of SECTIONS) {
                const card = /<p class="said"[^>]*>([\s\S]*?)<\/p>/.exec(stage(doc, s))![1]!;
                const first = casts[s][0]!;
                assert.ok(card.replace(/<[^>]+>/g, '').startsWith(first.t), s);
                assert.equal(/<span class="kw">([^<]+)<\/span>/.exec(card)![1], first.kw, s);
            }
        });
    });

    describe('the poster', () => {
        const poster = (s: string, doc: string) => /<svg class="stage-poster"[\s\S]*?<\/svg>/.exec(stage(doc, s))![0];
        const shapes = (svg: string) =>
            [...svg.matchAll(/<(rect|use)\b([^>]*)\/>/g)].map((m) => {
                const a = Object.fromEntries([...m[2]!.matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1]!, x[2]!]));
                return { tag: m[1]!, a };
            });

        it('is an aria-hidden SVG on a 400x480 board, with three ghost bubbles, one accent pill and the two Meta glyphs', () => {
            for (const [s, doc] of SECTIONS) {
                const svg = poster(s, doc);
                assert.match(svg, /^<svg class="stage-poster" aria-hidden="true" focusable="false" viewBox="0 0 400 480">/);
                assert.equal((svg.match(/class="pb"/g) ?? []).length, 3, `${s}: ghost bubbles`);
                assert.equal((svg.match(/class="pk"/g) ?? []).length, 1, `${s}: one lit pill`);
                assert.deepEqual([...svg.matchAll(/href="#plogo-([a-z]+)"/g)].map((m) => m[1]), ['instagram', 'facebook'], s);
                assert.equal(/<text|<image|url\(|<style|transform=|filter=/.test(svg), false, `${s}: shapes and sprite glyphs only, nothing that flips`);
            }
        });

        it('the Arabic poster is the English one authored mirrored (x -> 400 - x - width), never flipped', () => {
            const en = shapes(poster('en', L.en));
            const ar = shapes(poster('ar', L.ar));
            assert.equal(ar.length, en.length);
            assert.ok(en.length >= 12, 'three ghost bubbles, a pill, bars and two glyphs');
            en.forEach((e, i) => {
                const a = ar[i]!;
                assert.equal(a.tag, e.tag);
                assert.equal(Number(a.a.x), 400 - Number(e.a.x) - Number(e.a.width), `shape ${i}: x`);
                for (const k of ['y', 'width', 'height', 'rx', 'class', 'href']) assert.equal(a.a[k], e.a[k], `shape ${i}: ${k}`);
            });
            // And the page does not flip it either.
            for (const r of rulesNaming(/\.stage-poster/)) {
                assert.equal(/transform|scale|rotate|direction|unicode-bidi|writing-mode/.test(r.body), false, r.sel);
            }
        });

        it('is painted from tokens, the glyphs from --logo-mono', () => {
            assert.match(rulesNaming(exact('.stage-poster use'))[0]!.body, /fill:\s*var\(--logo-mono\)/);
            assert.match(rulesNaming(exact('.stage-poster .pk'))[0]!.body, /fill:\s*var\(--accent-soft\);\s*stroke:\s*var\(--accent-ring\)/);
            assert.match(rulesNaming(exact('.stage-poster .pb'))[0]!.body, /fill:\s*var\(--surface-solid\)/);
        });
    });

    describe('the CSS', () => {
        const mine = [
            css.slice(css.indexOf('.hero {\n            padding-block: clamp'), css.indexOf('.hero-grid {')),
            css.slice(css.indexOf('.hero-stage {'), css.indexOf('.loop {')), // comments are stripped: the stage block ends where the loop's rail begins
        ].join('\n');

        it("uses logical properties, only the page's breakpoints and no colour literal", () => {
            assert.ok(mine.includes('.hero-stage') && mine.includes('.hero {') && mine.includes('hero-receipt'));
            for (const re of [/\b(?:margin|padding)-(?:left|right)\b/, /\bborder-(?:left|right)\b/, /(?<![-\w])(?:left|right)\s*:/, /\bfloat\s*:/, /text-align\s*:\s*(?:left|right)\b/]) {
                assert.equal(re.test(mine), false, String(re));
            }
            for (const m of mine.matchAll(/@media \((?:min|max)-width: ([\d.]+)rem\)/g)) assert.ok(['30', '40', '48', '51.999', '52', '62'].includes(m[1]!), `breakpoint ${m[1]}rem`);
            assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(mine), false, 'tokens only');
        });

        it('stacks the card (z 1) over the poster and canvas (z 0, unclickable), in its own stacking context', () => {
            const body = (re: RegExp) => rulesNaming(re).map((r) => r.body).join('\n');
            assert.match(body(exact('.hero-stage')), /position:\s*relative/);
            assert.match(body(exact('.hero-stage')), /isolation:\s*isolate/);
            assert.match(body(exact('.hero-stage > .artifact')), /z-index:\s*1/);
            const layer = body(exact('.stage-poster, .stage-canvas'));
            assert.match(layer, /position:\s*absolute/);
            assert.match(layer, /z-index:\s*0/);
            assert.match(layer, /pointer-events:\s*none/);
            assert.match(rulesNaming(exact('.hero'))[0]!.body, /overflow-x:\s*clip/);
        });

        it('reaches past the card by space-6 above and below by default, and space-7 / space-6 from 62rem; the card is solid under the scene', () => {
            assert.match(css, /\.hero-stage \{\s*--hs-y: var\(--space-6\);\s*--hs-x: 0px;/);
            assert.match(css, /@media \(min-width: 62rem\) \{\s*\.hero-stage \{ --hs-y: var\(--space-7\); --hs-x: var\(--space-6\); \}/);
            assert.match(css, /inset-block-start:\s*calc\(var\(--hs-y\) \* -1\)/);
            assert.match(css, /block-size:\s*calc\(100% \+ var\(--hs-y\) \* 2\)/);
            assert.match(css, /inline-size:\s*calc\(100% \+ var\(--hs-x\) \* 2\)/);
            assert.match(rulesNaming(exact('.hero-stage.is-3d > .artifact'))[0]!.body, /background:\s*var\(--surface-solid\)/);
        });

        it('cross-fades over 320 ms, and takes no space: nothing in the stage is in flow but the card', () => {
            assert.match(css, /--lp-t-fade:\s*320ms/);
            assert.match(rulesNaming(exact('.stage-poster, .stage-canvas'))[0]!.body, /transition:\s*opacity var\(--lp-t-fade\)/);
            assert.match(rulesNaming(exact('.hero-stage.is-3d .stage-canvas'))[0]!.body, /opacity:\s*1/);
            assert.match(rulesNaming(exact('.hero-stage.is-3d .stage-poster'))[0]!.body, /opacity:\s*0/);
            assert.match(rulesNaming(exact('.stage-toggle'))[0]!.body, /position:\s*absolute/);
        });

        it('swaps the toggle icon on the stage, keeps the toggle a circle on focus, and gives Safari 15 (no overflow: clip) no reach into the gutters', () => {
            assert.match(css, /\.hero-stage\.is-paused \.i-pause,\s*\.hero-stage:not\(\.is-paused\) \.i-play \{ display: none; \}/);
            assert.match(rulesNaming(exact('.stage-toggle:focus-visible'))[0]!.body, /border-radius:\s*var\(--radius-pill\)/);
            assert.match(css, /@supports not \(overflow-x: clip\) \{\s*\.hero-stage \{ --hs-x: 0px; \}\s*\}/);
            // It must come after the 62rem rule that gives --hs-x its reach, or that rule would win.
            assert.ok(css.indexOf('@supports not (overflow-x: clip)') > css.indexOf('--hs-x: var(--space-6); }'), 'the @supports rule is later in the source than the media rule');
        });

        it('is hidden under forced colours and in print, and the receipt is one ring, once', () => {
            assert.match(css, /@media \(forced-colors: active\), print \{\s*\.stage-poster,\s*\.stage-canvas,\s*\.stage-toggle \{ display: none; \}/);
            assert.match(css, /\.hero-stage \.bubble\.is-delivering \{ animation: hero-receipt var\(--lp-kw-receipt\) var\(--ease-exit\) 1; \}/);
            assert.match(css, /--lp-kw-receipt:\s*800ms/);
            assert.match(css, /@keyframes hero-receipt \{\s*0%, 100% \{[^}]*0 0 0 0 var\(--accent-ring\)[^}]*\}\s*40% \{[^}]*0 0 0 var\(--ring\) var\(--accent-ring\)/);
        });
    });

    describe('the loader (its own inline script, the last in the page)', () => {
        const scripts = [...landing.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
        const script = scripts[scripts.length - 1]!;
        const shippedAt = script.indexOf('        /* The hero scene (L10): the loader.');
        const shipped = script.slice(shippedAt);
        const code = shipped.replace(/\/\*[\s\S]*?\*\//g, '');   // what runs: the comment says import() too

        it('is a script element of its own, right after the shared one, so a browser that cannot parse import() loses only this', () => {
            assert.equal(scripts.filter((s) => s.includes('import(')).length, 1, 'import() is in exactly one script');
            assert.ok(script.includes('import(HERO3D)'));
            assert.ok(shippedAt > 0, 'the loader is the last script');
            const shared = scripts[scripts.length - 2]!;
            assert.ok(shared.includes('is-inview') && shared.includes('data-set-lang'), 'the script before it is the shared one: the switch, the rows, the diagrams');
            assert.equal(shared.includes('import('), false, 'the shared script is plain ES5: it parses everywhere');
            assert.equal((shared.match(/\n {8}\(function \(\) \{\n/g) ?? []).length, 4, 'the switch, the fragments, the rows, the diagrams and video');
            assert.equal((script.match(/\n {8}\(function \(\) \{\n/g) ?? []).length, 1, 'one IIFE in the loader script');
            assert.match(landing, /<\/script>\s*<script>\s*\/\* The hero scene \(L10\): the loader\./, 'adjacent, with nothing between them');
            assert.match(landing, /<\/script>\s*<\/body>/, 'and it is the last thing in the body');
        });

        it('keeps every gate the spec names', () => {
            for (const gate of [
                'prefers-reduced-motion:no-preference', 'c.saveData', '[23]g', 'n.deviceMemory < 4', 'n.hardwareConcurrency <',
                "coarse = ok('(pointer:coarse)')", 'coarse ? 6 : 4', "getContext('webgl2', { failIfMajorPerformanceCaveat: true })",
                ".offsetWidth < 300", 'n.webdriver', '3d=0', "sessionStorage.getItem('hero3d_off')", "localStorage.getItem('hero3d_paused')",
            ]) {
                assert.ok(shipped.includes(gate), `the loader has the gate ${gate}`);
            }
        });

        it('starts on load, when idle (a 1.2 s timer where there is no idle callback), and imports one file', () => {
            assert.match(shipped, /w\.addEventListener\('load', function \(\) \{\s*\(w\.requestIdleCallback \|\| function \(f\) \{ setTimeout\(f, 1200\); \}\)\(start, \{ timeout: 2000 \}\);/);
            assert.equal((code.match(/import\(/g) ?? []).length, 1);
            assert.match(shipped, /import\(HERO3D\)\.then\(function \(m\) \{ return m\.mount\(stages, \{ lite: coarse \}\); \}\)/);
            assert.equal(/console\.(?:error|warn)/.test(code), false, 'a failure is an info line');
        });

        it('a paused visitor never downloads three: go() returns while paused, before the import', () => {
            const go = /function go\(\) \{[\s\S]*?\n {12}\}/.exec(shipped)![0];
            assert.ok(go.indexOf('paused') > 0 && go.indexOf('paused') < go.indexOf('import('));
            assert.match(shipped, /api \? api\.pause\(paused\) : go\(\);/, 'a press pauses a running scene, or starts a load');
        });

        it('a pause pressed while the scene downloads is applied when it mounts', () => {
            assert.match(shipped, /\.then\(function \(a\) \{ api = a; if \(paused\) a\.pause\(true\); \}/);
        });

        it('a failed scene is never tried twice: the toggles go, the flag that blocks a second import stays set', () => {
            const reject = /, function \(e\) \{[\s\S]*?\n {20}\}\);/.exec(shipped)![0];
            assert.match(reject, /each\(function \(s\) \{ s\.lastElementChild\.remove\(\); \}\);/, 'the controls are removed');
            assert.match(reject, /console\.info\('hero3d: poster', e\);/);
            assert.equal(/busy = (?:0|false)/.test(shipped), false, 'busy is only ever set, so a later press cannot mount a second renderer');
            assert.match(shipped, /if \(busy \|\| api \|\| paused\) return;\s*busy = 1;/);
        });

        it('the toggle announces its state once: a name that swaps, and no aria-pressed', () => {
            assert.equal(shipped.includes('aria-pressed'), false);
            assert.match(shipped, /s\.lastElementChild\.setAttribute\('aria-label', s\.getAttribute\(paused \? 'data-play-label' : 'data-pause-label'\)\);/);
            assert.match(shipped, /s\.classList\.toggle\('is-paused', paused\);/);
            assert.match(shipped, /paused = false;/, 'a storage error leaves it false, never undefined');
            const tpl = /<template id="hero-toggle">[\s\S]*?<\/template>/.exec(landing)![0];
            assert.equal(/aria-pressed/.test(tpl) || /stage-toggle[^{]*\{[^}]*aria-pressed|\[aria-pressed[^\]]*\][^{]*\.i-(?:pause|play)/.test(css), false, 'neither the template nor the toggle CSS knows it');
        });

        it("names the bundle by its hash, with no ?v=, and the file is there; '' is the rollback", () => {
            const name = /var HERO3D = '([^']*)';/.exec(shipped)![1]!;
            assert.match(name, /^\/brand\/hero3d\.[0-9a-f]{8}\.js$/);
            assert.ok(statSync(`public${name}`).isFile(), name);
            assert.match(shipped, /if \(!HERO3D \|\|/, "HERO3D = '' switches it off");
        });

        it('is at most 1.2 KB gzipped as shipped, comment included, so the critical path grows by well under 2 KB', () => {
            const gz = gzipSync(shipped.replace(/\s+$/, '')).length;
            assert.ok(gz <= 1.2 * 1024, `${gz} bytes gzipped`);
        });

        it('adds no ?v= (a content-hashed file is its own version) and no script source: the import is same-origin, so the CSP is untouched', () => {
            assert.equal(/\/brand\/[^"'\s]*\?v=/.test(landing), false);
            assert.equal(/<script[^>]*\bsrc=/.test(noComments(landing)), false, 'no external <script src>');
            const api = readFileSync('src/routes/api.ts', 'utf8');
            assert.ok(api.includes(`"script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com",`), 'script-src is exactly what it was');
            assert.equal(/worker-src|script-src[^"]*blob:/.test(api), false);
        });
    });

    describe('serving /brand', () => {
        it('vercel.json routes /brand/* to public/brand, immutable for a year, after /samples and right before the catch-all', () => {
            const routes = (JSON.parse(readFileSync('vercel.json', 'utf8')) as { routes: Array<{ src: string; dest?: string; headers?: Record<string, string> }> }).routes;
            const srcs = routes.map((r) => r.src);
            const brand = routes.find((r) => r.src === '/brand/(.*)')!;
            assert.ok(brand);
            assert.equal(brand.dest, 'public/brand/$1');
            assert.deepEqual(brand.headers, { 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
            assert.ok(srcs.indexOf('/brand/(.*)') > srcs.indexOf('/samples/(.*)'));
            assert.equal(srcs.indexOf('/brand/(.*)'), srcs.indexOf('/(.*)') - 1, 'immediately before the catch-all');
        });

        it('src/index.ts serves /brand and /samples itself, off Vercel only', () => {
            const index = readFileSync('src/index.ts', 'utf8');
            assert.match(index, /if \(!process\.env\.VERCEL\) \{\s*app\.use\('\/samples', express\.static\('public\/samples'/);
            assert.match(index, /app\.use\('\/brand', express\.static\('public\/brand', \{ maxAge: '365d', immutable: true \}\)\);/);
        });
    });
});
