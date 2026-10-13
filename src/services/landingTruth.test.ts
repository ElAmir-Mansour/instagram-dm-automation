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
import { readFileSync } from 'node:fs';
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
    it('9:16, GIF, MP4, RAG vs CAG vs KAG, MIT, GitHub and the clock times never sit bare in the Arabic document', () => {
        // Remove each <bdi>…</bdi> run, then every tag (attribute values go with them): what is
        // left is the text a bidi algorithm would have to reorder. The existing page wraps
        // these in <bdi>; so must the new bands.
        const bare = L.ar.replace(/<bdi\b[^>]*>[^<]*<\/bdi>/g, ' ').replace(/<[^>]+>/g, ' ');
        // (04:12 is left out on purpose: the Studio band's screenshot clock has always been bare,
        // pinned left-to-right by its own CSS; the new bands' clocks are 11:40 and 23:05.)
        for (const token of ['9:16', 'GIF', 'MP4', 'RAG', 'CAG', 'KAG', 'MIT', 'GitHub', '11:40', '23:05']) {
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
