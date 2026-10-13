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
            for (const m of doc.matchAll(/href="#([^"]+)"/g)) assert.ok(have.has(m[1]!), `#${m[1]} (${suffix})`);
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
    ];

    for (const [name, html] of [['landing', landing], ['pricing', pricing]] as const) {
        it(`${name}: none of the removed claims is in the visible markup`, () => {
            const visible = words(noComments(html));
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

describe('landing — no horizontal scroll from the new CSS', () => {
    it('uses logical properties and the existing breakpoints only', () => {
        const css = /<style>[\s\S]*?<\/style>/.exec(landing)![0];
        const start = css.indexOf('The Monteur and Infographics');
        assert.ok(start > 0);
        const mine = css
            .slice(start, css.indexOf('The Studio\'s closing detail list', start))
            .replace(/\/\*[\s\S]*?\*\//g, ''); // the comments say "left-to-right"; only declarations count
        assert.equal(/\b(?:margin|padding)-(?:left|right)\b|\b(?:left|right):/.test(mine), false, 'physical properties');
        for (const m of mine.matchAll(/@media \((?:min|max)-width: ([\d.]+)rem\)/g)) {
            assert.ok(['30', '40', '48', '51.999', '52', '62'].includes(m[1]!), `new breakpoint ${m[1]}rem`);
        }
        assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(mine), false, 'a colour literal: tokens only');
    });
});
