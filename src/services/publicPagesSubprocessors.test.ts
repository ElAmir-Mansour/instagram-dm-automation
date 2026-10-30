/**
 * The AI providers named as sub-processors on /privacy and /data-deletion (P20d), in both languages.
 *
 * Meta, TikTok and Google reviewers and the account owners themselves read these pages, so each sentence is a claim about the product.
 * The AI providers layer is planned, not live (DESIGN.md §9's truth table), so what is pinned is the shape of an honest disclosure:
 *
 *   - the eight names (Anthropic, OpenAI, Google (Gemini), OpenRouter, Groq, Meta (Muse), Baseten, and an address the operator enters), in
 *     both languages, in the same order;
 *   - that they are used ONLY when the operator has added a key and left the provider on, which is the whole difference between "we use
 *     these" and "these are possible";
 *   - what goes to them (the account owner's profile and content, for drafting), and what does not (anything else about people who comment
 *     or message), with direct-message text named, not hidden: section 3 says when it reaches Google, and when, the operator having
 *     routed an account's DM replies to one, it reaches a provider instead (the `providers` engine and sales mode, dmEngine.ts);
 *   - that their copy is theirs and cannot be deleted by us, on the deletion page as well;
 *   - that the contents list still has one link per section (a sub-processor list is an h3, not a new section), and the stamps agree;
 *   - the alerts the operator gets when a conversation with his own account needs a person (section 3's last paragraph, section 5's
 *     Resend and Telegram, sections 2 and 7, and /data-deletion's "Alerts to the operator"): what triggers one, that it carries the
 *     person's username or the last four characters of their id and up to 200 characters of their last message, and that these are
 *     not the ads alerts, which carry nothing about a customer. The numbers are checked against notify.ts itself, so the page and the
 *     alert cannot drift apart;
 *   - Meta's AI models (Muse) and Baseten (the hackathon's P1, written AHEAD of the code, which arrives in P0, P2, P3 and P4): that the text of
 *     DMs and the media people send MAY be processed by Meta's models, only where the features are switched on (each is off by default);
 *     that the media FILE is never kept, only a short description or a transcript, deleted with the conversation; that only Meta's Standard
 *     models are used ("according to Meta", Meta's own words, never our promise on its behalf) and never its Contributor models; that the
 *     account owner's own published reels are watched by Meta's hosted models or by Meta's open model at Baseten, and that NO message,
 *     comment or follower data goes to Baseten; and that /terms lists the same providers. COMMENTS GO TO NO AI MODEL (comment intent, P6,
 *     was cut from the build on 2026-10-30): the pages say the comment path does not use an AI model, with no exception, and a guard fails
 *     if any page ties Meta's models to comments. Nothing here pins a claim that the code does it today: every sentence is conditional,
 *     which is the point of writing it first.
 *
 * The pages' bodies are otherwise untouched by this change, so the existing checks on them (publicPagesFiles, publicPagesChrome,
 * landingTruth's owner rules) are what say the rest is still true.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildNoticeText, excerpt, noticeWho, TELEGRAM_API } from './notify.js';
import { emailSubject, RESEND_API } from './notifyEmail.js';

const read = (p: string) => readFileSync(p, 'utf8');
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

/** What a reader reads: inline tags leave no gap, any other tag is a break. */
const words = (html: string) =>
    html
        .replace(/<\/?(?:bdi|a|span|strong|em|b)\b[^>]*>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ');

/** The part of a document from one marker to the next. */
function between(doc: string, from: string, to: string): string {
    const a = doc.indexOf(from);
    const b = doc.indexOf(to, a);
    assert.ok(a >= 0 && b > a, `${from} … ${to}`);
    return doc.slice(a, b);
}

const privacy = articles(read('public/privacy.html'));
const deletion = articles(read('public/data-deletion.html'));
const terms = articles(read('public/terms.html'));

/** The sub-processor block of /privacy: from its h3 to the next section. */
const block = {
    ar: between(privacy.ar, '<h3 id="ai-providers-ar">', '<h2 id="deletion-ar">'),
    en: between(privacy.en, '<h3 id="ai-providers-en">', '<h2 id="deletion-en">'),
};

describe('/privacy — the AI providers are named as sub-processors, in both languages', () => {
    it('sits inside "who else processes it", after the list of services and before deletion, as an h3 (the contents list is h2 only)', () => {
        for (const lang of ['ar', 'en'] as const) {
            const doc = privacy[lang];
            const processors = doc.indexOf(`<h2 id="processors-${lang}">`);
            const at = doc.indexOf(`<h3 id="ai-providers-${lang}">`);
            const deletionAt = doc.indexOf(`<h2 id="deletion-${lang}">`);
            assert.ok(processors > 0 && processors < at && at < deletionAt, lang);
            assert.equal((block[lang].match(/<h2\b/g) ?? []).length, 0, `${lang}: not a new section`);
        }
    });

    it('lists the same eight, in the same order, in Arabic and English, the operator\'s own address last', () => {
        const names = (html: string) => [...html.matchAll(/<li>\s*<strong>([\s\S]*?)<\/strong>/g)].map((m) => words(m[1]!).trim());
        const ar = names(block.ar);
        const en = names(block.en);
        assert.equal(ar.length, 8);
        assert.equal(en.length, 8);
        assert.deepEqual(en, ['Anthropic', 'OpenAI', 'Google', 'OpenRouter', 'Groq', 'Meta', 'Baseten', 'A service at an address the operator enters']);
        assert.deepEqual(ar.slice(0, 7), ['Anthropic', 'OpenAI', 'جوجل', 'OpenRouter', 'Groq', 'ميتا', 'Baseten']);
        assert.equal(ar[7], 'خدمة بعنوان يحدّده المُشغّل');
        assert.ok(words(block.ar).includes('Gemini') && words(block.en).includes('Gemini'));
        assert.ok(words(block.en).includes('OpenAI-compatible'));
        // Muse is the model family, said beside the company the way "Gemini" and "Claude" are.
        assert.ok(words(block.en).includes('Meta (Muse) — Meta\'s AI models.'));
        assert.ok(words(block.ar).includes('ميتا (Muse) — نماذج الذكاء الاصطناعي من ميتا.'));
    });

    it('says what Groq does with a request, and no more than its own page says: it keeps none by default, and may log one for up to 30 days for a fault or abuse', () => {
        const li = (doc: string) => doc.slice(doc.indexOf('Groq'), doc.indexOf('</li>', doc.indexOf('Groq')));
        const en = words(li(block.en));
        assert.ok(en.includes('Groq — runs the open model the operator chooses (such as OpenAI\'s gpt-oss) on its own hardware.'));
        assert.ok(en.includes('By default it keeps no request; it may log one for up to 30 days to investigate a fault or abuse.'));
        assert.ok(en.includes('How Groq handles API data'));
        const ar = words(li(block.ar));
        assert.ok(ar.includes('تشغّل النموذج المفتوح الذي يختاره المُشغّل (مثل gpt-oss من OpenAI) على عتادها الخاص.'));
        assert.ok(ar.includes('لا تحتفظ بأي طلب افتراضياً، وقد تسجّل طلباً مدةً أقصاها 30 يوماً للتحقق من عطل أو من إساءة استخدام.'));
        assert.ok(ar.includes('كيف تتعامل Groq مع بيانات الواجهة البرمجية'));
        // Every Latin name in the Arabic entry sits in its own <bdi>, as the neighbouring entries do, or the punctuation around it reorders.
        const arRaw = li(block.ar);
        for (const latin of ['Groq', 'gpt-oss', 'OpenAI']) assert.match(arRaw, new RegExp(`<bdi lang="en" dir="ltr">${latin}</bdi>`), latin);
    });

    it('says they are used only when the operator has added a key and left the provider on, and that until then nothing reaches them', () => {
        assert.ok(words(block.en).includes('None of them is used unless the operator has added its key and left it switched on; until then nothing reaches it.'));
        assert.ok(words(block.ar).includes('لا يُستخدم أيٌّ منهم إلا إن أضاف المُشغّل مفتاحه وأبقاه مفعّلاً، وما لم يفعل ذلك لا يصله شيء.'));
    });

    it('says what is sent (the account owner\'s profile and content, to write a draft) and what is not (anything else about people who comment or message)', () => {
        assert.ok(words(block.en).includes('the account owner\'s profile and content'));
        assert.ok(words(block.en).includes('so that a draft can be written for them'));
        assert.ok(words(block.en).includes('nothing else about people who comment or message on Instagram or Facebook is sent through this route'));
        assert.ok(words(block.ar).includes('ملف صاحب الحساب ومحتواه'));
        assert.ok(words(block.ar).includes('ولا يُرسَل عبر هذا المسار شيء غير ذلك عمّن يعلّق أو يراسل على إنستجرام أو فيسبوك'));
        assert.ok(!words(block.en).includes('Nothing about people who comment'), 'the old, absolute denial is gone: DM text can reach a provider');
    });

    it('does not hide direct-message text: a provider the operator routes an account\'s DM replies to receives the conversation, as section 3 says', () => {
        assert.ok(words(block.en).includes('where the operator chooses, the replies to its direct messages (section 3)'));
        assert.ok(words(block.en).includes('When the operator has a provider write an account\'s direct-message replies, the text of the conversation is sent to that provider too, exactly as section 3 describes'));
        assert.ok(words(block.ar).includes('والردودَ على رسائله الخاصة حيث يختار المُشغّل ذلك (القسم 3)'));
        assert.ok(words(block.ar).includes('وحين يجعل المُشغّل أحد المزوّدين يكتب ردود حسابٍ على رسائله الخاصة، يُرسَل نصّ المحادثة إلى ذلك المزوّد أيضاً، على النحو الموضّح في القسم 3 تماماً'));
        assert.ok(privacy.en.includes('id="gemini-en"') && privacy.ar.includes('id="gemini-ar"'), 'and section 3 is there');
    });

    it('section 3 says what a provider gets in place of Google: up to twelve messages and notes on the conversation, no name or ids, Gemini as the fallback', () => {
        const en = words(between(privacy.en, '<h2 id="gemini-en">', '<h2 id="retention-en">'));
        assert.ok(en.includes('generate one, by default, the text of your message and the last eight messages in the thread are sent to Google\'s Gemini API'));
        assert.ok(en.includes('an account that uses the tool\'s sales mode always has them written that way'));
        assert.ok(en.includes('the text of your message and up to the last twelve messages in the thread, with the direction of each, are sent to that provider in place of Google'));
        assert.ok(en.includes('or that you commented the account\'s keyword on a post (the keyword, not your comment)'));
        // The notes are the sales turn's alone (salesFactsBlock): the plain `providers` engine sends the history and nothing else.
        assert.ok(en.includes('are sent to that provider in place of Google. In sales mode they go together with notes about the conversation itself'));
        // A3: the ad's context, only with the owner's switch, and only its name, offer and text (adFactsFor), as section 1's ads list says.
        assert.ok(en.includes('if you came from one of the account\'s ads and the account owner has turned on "Give the assistant the ad\'s context", that ad\'s name, offer and text (section 1)'));
        assert.ok(en.includes('Your username, your account ID and the conversation ID are not sent to it either.'));
        assert.ok(en.includes('If that provider cannot answer, the reply may be written by Gemini as described above.'));
        const ar = words(between(privacy.ar, '<h2 id="gemini-ar">', '<h2 id="retention-ar">'));
        assert.ok(ar.includes('يُرسَل افتراضياً نصّ رسالتك وآخر ثماني رسائل من المحادثة'));
        assert.ok(ar.includes('والحساب الذي يستخدم وضع المبيعات في الأداة تُكتب ردوده بهذه الطريقة دائماً'));
        assert.ok(ar.includes('نصّ رسالتك وما يصل إلى آخر اثنتي عشرة رسالة من المحادثة، مع اتجاه كل رسالة، إلى ذلك المزوّد بدلاً من جوجل'));
        assert.ok(ar.includes('(الكلمة نفسها، لا تعليقك)'));
        assert.ok(ar.includes('إلى ذلك المزوّد بدلاً من جوجل. وفي وضع المبيعات تُرسَل معها ملاحظات عن المحادثة نفسها'));
        assert.ok(ar.includes('وإن جئتَ من أحد إعلانات الحساب وشغّل صاحب الحساب «أعطِ المساعد سياق الإعلان»، فاسمُ ذلك الإعلان وعرضُه ونصُّه (القسم 1)'));
        assert.ok(ar.includes('ولا يُرسَل إليه كذلك اسمك ولا معرّف حسابك ولا معرّف المحادثة.'));
        assert.ok(ar.includes('وإن تعذّر على ذلك المزوّد الردّ، فقد يكتب الردَّ «جيميناي» كما سبق.'));
    });

    it('says the operator\'s key is the one used, and that each provider\'s copy is its own, which we cannot delete', () => {
        assert.ok(words(block.en).includes('Each provider is used with the operator\'s key, not the account owner\'s.'));
        assert.ok(words(block.en).includes('we cannot delete it on your behalf'));
        assert.ok(words(block.ar).includes('ويعمل كل مزوّد بمفتاح المُشغّل، لا بمفتاح صاحب الحساب'));
        assert.ok(words(block.ar).includes('ولا نستطيع حذفه نيابةً عنك'));
    });

    it('links each named provider\'s own policy, opened safely, and links nothing else out', () => {
        for (const lang of ['ar', 'en'] as const) {
            const links = [...block[lang].matchAll(/<a\b([^>]*)>/g)].map((m) => m[1]!);
            const hrefs = links.map((attrs) => /href="([^"]+)"/.exec(attrs)?.[1]);
            assert.deepEqual(hrefs, [
                'https://www.anthropic.com/legal/privacy',
                'https://openai.com/policies/privacy-policy/',
                'https://policies.google.com/privacy',
                'https://openrouter.ai/privacy',
                'https://console.groq.com/docs/your-data',
                // Meta's own developer site (dev.meta.ai) gives this as its Privacy Policy, and section 5's Meta line uses it too;
                // Baseten's own footer gives the second one (the 'privacy/' path 404s).
                'https://www.facebook.com/privacy/policy/',
                'https://www.baseten.co/privacy-policy/',
            ], lang);
            for (const attrs of links) assert.match(attrs, /target="_blank" rel="noopener noreferrer"/, lang);
        }
    });

    it('keeps the contents list at one link per section, and gives both languages the same date', () => {
        for (const lang of ['ar', 'en'] as const) {
            const doc = privacy[lang];
            const toc = /<nav class="toc"[\s\S]*?<\/nav>/.exec(doc)![0];
            const h2 = [...doc.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]);
            assert.deepEqual([...toc.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]), h2, lang);
        }
        assert.ok(privacy.ar.includes('آخر تحديث: 30 أكتوبر 2026') && privacy.en.includes('Last updated: 30 October 2026'));
    });
});

describe('/data-deletion — the same providers are named among what deletion cannot reach', () => {
    const section5 = {
        ar: between(deletion.ar, '<h2>5. ما لا يستطيع الحذف الوصول إليه</h2>', '<h2>6. '),
        en: between(deletion.en, '<h2>5. What deletion cannot reach</h2>', '<h2>6. '),
    };

    it('has the bullet in section 5 of each language, after Google\'s and before the logs', () => {
        for (const lang of ['ar', 'en'] as const) {
            const doc = section5[lang];
            const google = doc.indexOf(lang === 'ar' ? '<strong>جوجل:</strong>' : '<strong>Google:</strong>');
            const ai = doc.indexOf(lang === 'ar' ? '<strong>مزوّدو الذكاء الاصطناعي:</strong>' : '<strong>AI providers:</strong>');
            const logs = doc.indexOf(lang === 'ar' ? '<strong>سجلّات التشغيل:</strong>' : '<strong>Operational logs:</strong>');
            assert.ok(google > 0 && google < ai && ai < logs, lang);
        }
    });

    it('names the providers (Meta (Muse) among them) and the operator\'s own address, scopes it to account owners, and says the copy is theirs', () => {
        const en = words(section5.en);
        for (const name of ['Anthropic', 'OpenAI', 'Google (Gemini)', 'OpenRouter', 'Groq', 'Meta (Muse)', 'a service at an address the operator added']) assert.ok(en.includes(name), name);
        // Baseten never writes a reply and never sees a message, so it is NOT in the list of providers "the operator has write replies": it is named
        // once, in the Meta bullet, beside the reels (a reader of the list would otherwise be told their conversation may have reached it).
        const aiBullet = (doc: string, marker: string) => doc.slice(doc.indexOf(marker), doc.indexOf('</li>', doc.indexOf(marker)));
        assert.ok(!aiBullet(section5.en, '<strong>AI providers:</strong>').includes('Baseten'));
        assert.ok(!aiBullet(section5.ar, '<strong>مزوّدو الذكاء الاصطناعي:</strong>').includes('Baseten'));
        assert.ok(en.includes('Baseten') && words(section5.ar).includes('Baseten'));
        assert.ok(en.includes('if you are an account owner and the operator of the tool has switched on a provider'));
        assert.ok(en.includes('we cannot delete it on your behalf'));
        assert.ok(en.includes('the text of your conversation reached that provider instead of Google (section 3 of the privacy policy)'));
        assert.ok(en.includes('Nothing else about people who comment or message on Instagram or Facebook is sent to them'));
        const ar = words(section5.ar);
        for (const name of ['Anthropic', 'OpenAI', 'Gemini', 'OpenRouter', 'Groq', 'ميتا (Muse)']) assert.ok(ar.includes(name), name);
        assert.ok(ar.includes('إن كنتَ صاحب حساب وفعّل مُشغّل الأداة مزوّداً'));
        assert.ok(ar.includes('ولا نستطيع حذفها نيابةً عنك'));
        assert.ok(ar.includes('فقد وصل نصّ محادثتك إلى ذلك المزوّد بدلاً من جوجل (القسم 3 من سياسة الخصوصية)'));
        assert.ok(ar.includes('ولا يصلهم شيء غير ذلك عمّن يعلّق أو يراسل على إنستجرام أو فيسبوك'));
    });

    it('points to the list on /privacy, by section, in both languages', () => {
        for (const lang of ['ar', 'en'] as const) {
            const doc = section5[lang];
            const bullet = doc.slice(doc.indexOf(lang === 'ar' ? 'مزوّدو الذكاء الاصطناعي' : 'AI providers:'));
            assert.match(bullet, /القسم 5 من <a href="\/privacy">سياسة الخصوصية<\/a>|section 5 of the <a href="\/privacy">privacy policy<\/a>/, lang);
        }
    });

    it('carries the same date in both languages', () => {
        assert.ok(deletion.ar.includes('آخر تحديث: 30 أكتوبر 2026') && deletion.en.includes('Last updated: 30 October 2026'));
    });
});

describe('/privacy and /data-deletion — the alerts the operator gets when a conversation needs a person (Telegram, Resend)', () => {
    const section3 = {
        ar: words(between(privacy.ar, '<h2 id="gemini-ar">', '<h2 id="retention-ar">')),
        en: words(between(privacy.en, '<h2 id="gemini-en">', '<h2 id="retention-en">')),
    };
    /** Section 5's list of services: from its h2 to the AI providers' h3. */
    const services = {
        ar: between(privacy.ar, '<h2 id="processors-ar">', '<h3 id="ai-providers-ar">'),
        en: between(privacy.en, '<h2 id="processors-en">', '<h3 id="ai-providers-en">'),
    };

    it('section 3 says when an alert is sent, to whom, by which services, and what of yours it carries', () => {
        const en = section3.en;
        assert.ok(en.includes('the operator of the tool (section 9) may be alerted when no reply to your message could be written (a technical failure)'));
        assert.ok(en.includes('in sales mode, when the assistant hands your conversation to a person (for example because you asked for one, asked for a refund or complained) or has just sent you the link after you asked to buy, asked the price or asked whether it suits you'));
        assert.ok(en.includes('This happens only for conversations with his own account, and only if he has switched the alerts on.'));
        assert.ok(en.includes('The alert is a Telegram message and/or an email sent through Resend (section 5).'));
        assert.ok(en.includes('It names you by your username, or, if we have none, by the last four characters of your account ID, and quotes up to 200 characters of the last message you wrote, with any link in it replaced by “[link]”.'));
        assert.ok(en.includes('It also says why a person is needed, how long Meta\'s reply window has left, and links to the conversation in the dashboard.'));
        const ar = section3.ar;
        assert.ok(ar.includes('قد يُنبَّه مُشغّل الأداة (القسم 9) إذا تعذّرت كتابة ردّ على رسالتك (عطل تقني)'));
        assert.ok(ar.includes('وكذلك في وضع المبيعات حين يحوّل المساعد محادثتك إلى شخص (كأن تطلب التحدّث إلى شخص أو استرجاع مالك أو تشتكي)، أو حين يرسل إليك الرابط بعد أن سألت عن الشراء أو عن السعر أو عن مناسبته لك.'));
        assert.ok(ar.includes('ولا يحدث ذلك إلا في المحادثات مع حسابه هو، وإلا إن فعّل التنبيهات.'));
        assert.ok(ar.includes('والتنبيه رسالة على تيليجرام و/أو بريد إلكتروني يُرسَل عبر Resend (القسم 5).'));
        assert.ok(ar.includes('يُذكر فيه اسم المستخدم الخاص بك، أو آخر أربعة أحرف من معرّف حسابك إن لم يكن لدينا اسم مستخدم لك، وما يصل إلى 200 حرف من آخر رسالة كتبتَها، وتُستبدَل الروابط فيها بـ«[link]».'));
        assert.ok(ar.includes('ويُذكر فيه أيضاً سبب الحاجة إلى شخص، والوقت الباقي من نافذة الردّ لدى ميتا، ورابط إلى المحادثة في لوحة التحكم.'));
        // Every Latin word in the Arabic paragraph sits in its own <bdi>, or the punctuation around it reorders.
        const arRaw = between(privacy.ar, '<h2 id="gemini-ar">', '<h2 id="retention-ar">');
        for (const latin of ['Resend', '[link]']) assert.ok(arRaw.includes(`<bdi lang="en" dir="ltr">${latin}</bdi>`), latin);
    });

    it('keeps the ads alerts\' promise and says these alerts are not those: the ads alerts carry nothing about a customer', () => {
        assert.ok(words(privacy.en).includes('It never contains customer data or card data.'));
        assert.ok(words(privacy.ar).includes('ولا يحوي أبداً بيانات عملاء ولا بيانات بطاقات.'));
        assert.ok(section3.en.includes('These alerts are not the ads alerts in section 1, which contain nothing about you.'));
        assert.ok(section3.ar.includes('وهذه التنبيهات غير تنبيهات الإعلانات الموصوفة في القسم 1، التي لا تحتوي شيئاً عنك.'));
    });

    it('names Resend and Telegram in section 5, after the hosts and before the AI providers, each with its own policy, opened safely', () => {
        const names = (html: string) => [...html.matchAll(/<li>\s*<strong>([\s\S]*?)<\/strong>/g)].map((m) => words(m[1]!).trim());
        assert.deepEqual(names(services.en).slice(-3), ['Vercel', 'Resend', 'Telegram']);
        assert.deepEqual(names(services.ar).slice(-3), ['Vercel', 'Resend', 'تيليجرام']);
        for (const lang of ['ar', 'en'] as const) {
            const anchors = [...services[lang].matchAll(/<a\b([^>]*)>/g)].map((m) => m[1]!);
            const hrefs = anchors.map((attrs) => /href="([^"]+)"/.exec(attrs)?.[1]);
            assert.deepEqual(hrefs.slice(-2), ['https://resend.com/legal/privacy-policy', 'https://telegram.org/privacy'], lang);
            for (const attrs of anchors.slice(-2)) assert.match(attrs, /target="_blank" rel="noopener noreferrer"/, lang);
        }
        const en = words(services.en);
        assert.ok(en.includes('Resend — sends the alert emails, when they are switched on: the alerts about a conversation that needs a person, described in section 3, which carry your username (or the last four characters of your account ID) and up to 200 characters of your last message, and the ads alerts in section 1.'));
        assert.ok(en.includes('Telegram — delivers the same alerts as Telegram messages, to the chat set in Settings, when they are switched on.'));
        const ar = words(services.ar);
        assert.ok(ar.includes('Resend — يرسل رسائل التنبيه بالبريد الإلكتروني حين تكون مفعّلة: تنبيهات المحادثة التي تحتاج إلى شخص الموصوفة في القسم 3، وفيها اسم المستخدم الخاص بك (أو آخر أربعة أحرف من معرّف حسابك) وما يصل إلى 200 حرف من آخر رسالة كتبتَها، وتنبيهات الإعلانات الموصوفة في القسم 1.'));
        assert.ok(ar.includes('تيليجرام (Telegram) — يوصل التنبيهات نفسها رسائلَ إلى محادثة تيليجرام المحدّدة في الإعدادات، حين تكون مفعّلة.'));
        for (const latin of ['Resend', 'Telegram']) assert.ok(services.ar.includes(`<bdi lang="en" dir="ltr">${latin}</bdi>`), latin);
    });

    it('lists the alerts among the purposes (section 2), and no longer calls the dashboard the only place conversations are read (section 7)', () => {
        assert.ok(words(between(privacy.en, '<h2 id="purposes-en">', '<h2 id="gemini-en">')).includes('To alert the operator of the tool when a conversation with his own account needs a person (section 3).'));
        assert.ok(words(between(privacy.ar, '<h2 id="purposes-ar">', '<h2 id="gemini-ar">')).includes('تنبيه مُشغّل الأداة حين تحتاج محادثةٌ مع حسابه هو إلى شخص (القسم 3).'));
        const en = words(between(privacy.en, '<h2 id="security-en">', '<h2 id="changes-en">'));
        assert.ok(en.includes('The dashboard — the only place whole conversations are read from — is password-protected. An alert (section 3) carries only the excerpt described there.'));
        assert.ok(!en.includes('the only place conversations are read from'), 'the old sentence is gone: an alert quotes the last message');
        const ar = words(between(privacy.ar, '<h2 id="security-ar">', '<h2 id="changes-ar">'));
        assert.ok(ar.includes('لوحة التحكم — وهي المكان الوحيد الذي تُقرأ منه المحادثات كاملةً — محميّة بكلمة مرور. ولا يحمل التنبيه (القسم 3) إلا المقتطف الموصوف هناك.'));
    });

    it('/data-deletion says the alerts\' copies are beyond deletion, after the AI providers and before the logs', () => {
        const section5 = {
            ar: between(deletion.ar, '<h2>5. ما لا يستطيع الحذف الوصول إليه</h2>', '<h2>6. '),
            en: between(deletion.en, '<h2>5. What deletion cannot reach</h2>', '<h2>6. '),
        };
        for (const lang of ['ar', 'en'] as const) {
            const doc = section5[lang];
            const ai = doc.indexOf(lang === 'ar' ? '<strong>مزوّدو الذكاء الاصطناعي:</strong>' : '<strong>AI providers:</strong>');
            const alerts = doc.indexOf(lang === 'ar' ? '<strong>تنبيهات المُشغّل:</strong>' : '<strong>Alerts to the operator:</strong>');
            const logs = doc.indexOf(lang === 'ar' ? '<strong>سجلّات التشغيل:</strong>' : '<strong>Operational logs:</strong>');
            assert.ok(ai > 0 && ai < alerts && alerts < logs, lang);
        }
        const en = words(section5.en);
        assert.ok(en.includes('an alert sent to him by Telegram and/or by email through Resend may have carried your username (or the last four characters of your account ID) and up to 200 characters of your last message (section 3 of the privacy policy)'));
        assert.ok(en.includes('Those copies are in his Telegram chat and mailbox, and Telegram\'s and Resend\'s copies are governed by their own policies; deleting your data here does not reach them.'));
        const ar = words(section5.ar);
        assert.ok(ar.includes('فقد يكون تنبيهٌ أُرسل إليه على تيليجرام و/أو بالبريد الإلكتروني عبر Resend قد ذكر اسم المستخدم الخاص بك (أو آخر أربعة أحرف من معرّف حسابك) وما يصل إلى 200 حرف من آخر رسالة كتبتَها (القسم 3 من سياسة الخصوصية)'));
        assert.ok(ar.includes('وحذف بياناتك هنا لا يصل إليها.'));
    });

    it('the page\'s numbers are the alert\'s own: 200 characters with links replaced, the @username or the last four characters of the id, sent to Telegram and Resend', () => {
        const cut = excerpt('a'.repeat(300));
        assert.equal(Array.from(cut).length, 201, '200 characters kept, then the ellipsis');
        assert.ok(cut.startsWith('a'.repeat(200)) && cut.endsWith('…'));
        assert.equal(excerpt('see https://example.com/page now'), 'see [link] now');
        assert.equal(noticeWho({ lang: 'en', username: null, senderId: '17841400000001234', platform: 'instagram' }), 'Instagram user …1234');
        assert.equal(noticeWho({ lang: 'en', username: 'someone', senderId: '17841400000001234', platform: 'instagram' }), '@someone');
        const notice = {
            kind: 'handoff' as const, reason: 'wants_human', lang: 'en' as const, username: 'someone', senderId: '17841400000001234',
            lastMessage: 'x'.repeat(250), windowMs: null, link: null, platform: 'instagram',
        };
        const text = buildNoticeText(notice);
        assert.ok(text.includes('@someone') && text.includes(`«${'x'.repeat(200)}…»`));
        assert.ok(emailSubject(notice).endsWith('— @someone'));
        assert.equal(TELEGRAM_API, 'https://api.telegram.org');
        assert.equal(RESEND_API, 'https://api.resend.com');
    });
});

/**
 * Meta's AI models (Muse) and Baseten: the hackathon's P1, written BEFORE the code (P0 the provider, P2 reels/stories/photos, P3 voice,
 * P4 the video library and Baseten; comment reading, P6, is cut), so that no real message reaches Meta before the people who wrote it can
 * read that it may. These pin the shape of an honest disclosure, and nothing here says the code does it today.
 */
describe('/privacy, /data-deletion and /terms — Meta\'s AI models (Muse) and Baseten, written ahead of the code (hackathon P1)', () => {
    /** Every sentence is there, once the markup is out of the way. */
    const has = (text: string, ...sentences: string[]) => {
        for (const s of sentences) assert.ok(text.includes(s), s);
    };
    /** The part of /privacy section 3 that is about Meta: from its h3 to section 4. */
    const meta = {
        ar: between(privacy.ar, '<h3 id="meta-ai-ar">', '<h2 id="retention-ar">'),
        en: between(privacy.en, '<h3 id="meta-ai-en">', '<h2 id="retention-en">'),
    };
    /** The part of /privacy section 1 about the video library: from its h3 to section 2. */
    const reels = {
        ar: between(privacy.ar, '<h3 id="reels-ar">', '<h2 id="purposes-ar">'),
        en: between(privacy.en, '<h3 id="reels-en">', '<h2 id="purposes-en">'),
    };
    /** The "When you send a direct message" list of /privacy section 1, to the TikTok part. */
    const dmList = {
        ar: between(privacy.ar, '<h3>عندما ترسل رسالة خاصة</h3>', '<h3>عندما يربط صاحب الحساب تيك توك</h3>'),
        en: between(privacy.en, '<h3>When you send a direct message</h3>', '<h3>When the account owner connects TikTok</h3>'),
    };
    /** One list item, from the first occurrence of `marker` to its closing tag. */
    const item = (html: string, marker: string) => {
        const a = html.indexOf(marker);
        assert.ok(a >= 0, marker);
        return html.slice(a, html.indexOf('</li>', a));
    };

    it('section 3 gets an h3 for Meta\'s AI models, inside the section (the contents list is h2 only), after the alerts paragraph', () => {
        for (const lang of ['ar', 'en'] as const) {
            const doc = privacy[lang];
            const section = doc.indexOf(`<h2 id="gemini-${lang}">`);
            const alerts = doc.indexOf(lang === 'ar' ? 'حين تحتاج محادثتك إلى شخص:' : 'When your conversation needs a person:');
            const at = doc.indexOf(`<h3 id="meta-ai-${lang}">`);
            const next = doc.indexOf(`<h2 id="retention-${lang}">`);
            assert.ok(section > 0 && section < alerts && alerts < at && at < next, lang);
            assert.equal((meta[lang].match(/<h2\b/g) ?? []).length, 0, `${lang}: not a new section`);
        }
    });

    it('says what MAY reach Meta\'s models, and that every one of the features is off unless it has been switched on', () => {
        has(words(meta.en),
            'The operator of the tool (section 9) can switch on Meta\'s AI models, called Muse, as one of the providers in section 5, and the account owner can then switch on, for the account, the features below.',
            'Each of them is off unless it has been switched on.',
            'the text of direct messages and the media people send may be processed by Meta\'s AI models (Muse)',
            'Direct messages: the text of your message and the earlier messages of the thread are sent to Meta\'s models to write the reply, in place of Google, as described above for any provider.',
            'Photos, videos, shared posts, reels and stories, replies to the account\'s stories, and stories that mention the account (Instagram direct messages only, not Messenger): a model looks at the file and describes it, so that the reply is about what you sent instead of asking you to type it again.',
            'Voice notes: Meta\'s speech model turns the recording into text, which is then answered like a written message.',
            // No "once": the design retries a reel whose analysis failed the next day (the job's dedupe key carries the date).
            'The account owner\'s own reels: a model watches each one, to build the video library described in section 1.',
        );
        has(words(meta.ar),
            'يستطيع مُشغّل الأداة (القسم 9) أن يفعّل نماذج الذكاء الاصطناعي من ميتا، واسمها Muse، مزوّداً من المزوّدين المذكورين في القسم 5، ثم يستطيع صاحب الحساب أن يفعّل للحساب الميزات التالية.',
            'وكل ميزة منها متوقفة ما لم تُشغَّل.',
            'قد تُعالَج نصوص الرسائل الخاصة والوسائط التي يرسلها الناس بنماذج الذكاء الاصطناعي من ميتا (Muse)',
            'الرسائل الخاصة: يُرسَل نصّ رسالتك وما سبقها من رسائل المحادثة إلى نماذج ميتا لتكتب الردّ بدلاً من جوجل، على النحو الموضّح أعلاه لأي مزوّد.',
            'الصور ومقاطع الفيديو والمنشورات والريلز والقصص المُشارَكة، والردود على قصص الحساب، والقصص التي يُذكر فيها الحساب (للرسائل الخاصة على إنستجرام فقط، لا ماسنجر): ينظر نموذجٌ في الملف ويصفه، ليكون الردّ عمّا أرسلتَه بدلاً من أن يطلب منك كتابته من جديد.',
            'الرسائل الصوتية: تُحوَّل الرسالة الصوتية إلى نص بنموذج ميتا للكلام، ثم يُجاب عنه كما يُجاب عن رسالة مكتوبة.',
            'ريلز صاحب الحساب نفسه: يشاهد نموذجٌ كلاً منها لبناء مكتبة الفيديوهات الموصوفة في القسم 1.',
        );
        // Every Latin name in the Arabic block sits in its own <bdi>, as its neighbours do, or the punctuation around it reorders.
        for (const latin of ['Muse', 'Standard', 'Contributor']) assert.ok(meta.ar.includes(`<bdi lang="en" dir="ltr">${latin}</bdi>`), latin);
    });

    it('says the file is never kept, what is kept instead, and that it goes with the conversation', () => {
        has(words(meta.en),
            'The media file is not kept. The app downloads it, sends it to the model and discards it.',
            'What it keeps, with your message, is a short description of what it showed or, for a voice note, a transcript (section 1), which is deleted with your conversation if you ask for it to be erased (see the data deletion page).',
            'The model sees everything a photo or a video shows.',
        );
        has(words(meta.ar),
            'لا يُحفَظ ملف الوسائط. تنزّله الأداة وترسله إلى النموذج ثم تتخلّص منه.',
            'وما تحتفظ به مع رسالتك وصفٌ قصير لما ظهر فيه، أو نصٌّ لما قيل إن كان رسالة صوتية (القسم 1)، ويُحذف مع محادثتك إن طلبتَ حذفها (صفحة حذف البيانات).',
            'ويرى النموذج كل ما تُظهره الصورة أو الفيديو.',
        );
        assert.ok(meta.en.includes('<a href="/data-deletion">data deletion page</a>') && meta.ar.includes('<a href="/data-deletion">صفحة حذف البيانات</a>'));
    });

    it('uses Meta\'s Standard models only, says no-training as META\'s statement and never as our promise, names Contributor only to say it is never used, and sends no name or id', () => {
        has(words(meta.en),
            'Standard models only. The app uses only Meta\'s Standard models: according to Meta, the content they receive is not used to train Meta\'s models.',
            'It never uses Meta\'s "Contributor" models, which may be trained on what they receive, with anything people send or with the account owner\'s videos.',
            'Your username, your account ID and the conversation ID are not sent to Meta\'s models either.',
            'What Meta itself keeps of what it receives is governed by its own policy, and we cannot delete it on your behalf.',
        );
        has(words(meta.ar),
            'النماذج القياسية فقط. لا تستخدم الأداة إلا نماذج ميتا القياسية (Standard)، والمحتوى الذي تتلقّاه لا يُستخدم، بحسب ميتا، في تدريب نماذجها.',
            'ولا تستخدم أبداً نماذج Contributor من ميتا، وهي التي قد تُدرَّب على ما تتلقّاه، لا مع شيء يرسله الناس ولا مع فيديوهات صاحب الحساب.',
            'ولا يُرسَل إلى نماذج ميتا كذلك اسمك ولا معرّف حسابك ولا معرّف المحادثة.',
            'وما تحتفظ به ميتا نفسها ممّا يصلها تحكمه سياستها هي، ولا نستطيع حذفه نيابةً عنك.',
        );
        // The Contributor models are named once on each page that names them, and in a sentence that says they are never used.
        for (const lang of ['ar', 'en'] as const) {
            for (const [name, doc] of [['privacy', privacy[lang]], ['data-deletion', deletion[lang]], ['terms', terms[lang]]] as const) {
                const text = words(doc);
                const hits = [...text.matchAll(/Contributor/g)];
                assert.equal(hits.length, name === 'privacy' ? 1 : 0, `${name} ${lang}`);
                if (name === 'privacy') assert.ok(lang === 'ar' ? text.includes('ولا تستخدم أبداً نماذج Contributor') : text.includes('It never uses Meta\'s "Contributor" models'), lang);
            }
        }
    });

    it('never promises on Meta\'s behalf: every "not used to train" is Meta\'s own statement ("according to Meta"), on /privacy and on /data-deletion', () => {
        for (const [name, doc] of [['privacy', privacy.en], ['data-deletion', deletion.en]] as const) {
            const text = words(doc);
            const hits = [...text.matchAll(/not used to train/g)];
            assert.ok(hits.length >= 1, name);
            for (const m of hits) assert.match(text.slice(Math.max(0, m.index! - 120), m.index!), /according to meta/i, `${name}: …${text.slice(m.index! - 60, m.index! + 40)}…`);
        }
        for (const [name, doc] of [['privacy', privacy.ar], ['data-deletion', deletion.ar]] as const) {
            const text = words(doc);
            const hits = [...text.matchAll(/تدريب/g)];
            assert.ok(hits.length >= 1, name);
            for (const m of hits) assert.match(text.slice(Math.max(0, m.index! - 120), m.index!), /بحسب ميتا/, `${name}: …${text.slice(m.index! - 60, m.index! + 40)}…`);
        }
    });

    it('section 3 says the comment path does not use an AI model, with no exception: comment reading is not built (P6 is cut)', () => {
        const en = words(between(privacy.en, '<h2 id="gemini-en">', '<h2 id="retention-en">'));
        // The full stop right after "model" is the pin: any "except where …" clause would stand between them.
        has(en, 'Comment text is never sent to Google at all, and the comment path does not use an AI model.');
        const ar = words(between(privacy.ar, '<h2 id="gemini-ar">', '<h2 id="retention-ar">'));
        has(ar, 'ونصوص التعليقات لا تُرسَل إلى جوجل إطلاقاً، ومسار التعليقات لا يستخدم نموذج ذكاء اصطناعي.');
    });

    it('NO page says Meta\'s models read comments: the Meta blocks do not mention comments at all, and no sentence on any page ties Meta\'s models to them', () => {
        // 1. The blocks that are about Meta's models say nothing about comments, in either language.
        const metaBlocks = {
            en: [meta.en, item(block.en, '<strong>Meta</strong> (Muse)'), item(block.en, '<strong>Baseten</strong>'), reels.en],
            ar: [meta.ar, item(block.ar, '<strong>ميتا</strong>'), item(block.ar, '<strong><bdi lang="en" dir="ltr">Baseten</bdi></strong>'), reels.ar],
        };
        // The one thing they may say is that NO comment data goes into the library, and none goes to Baseten.
        const negations = {
            en: [/no comment, message, contact or follower data/gi, /no message, comment or follower data/gi],
            ar: [/لا بيانات تعليقات ولا رسائل ولا متابعين/g, /أي بيانات عن رسالة أو تعليق أو متابع/g],
        };
        for (const lang of ['ar', 'en'] as const) {
            for (const html of metaBlocks[lang]) {
                let text = words(html);
                for (const re of negations[lang]) text = text.replace(re, '');
                assert.ok(!(lang === 'en' ? /comment/i : /تعليق/).test(text), `${lang}: …${text.slice(0, 80)}…`);
            }
        }
        // 2. On all three pages, a sentence that names Meta's AI models and a comment is allowed only as a negation ("people who comment or
        //    message" is the pre-existing "nothing else about people who comment or message is sent" and is stripped first).
        const NAMES_META_MODELS = { en: /Muse|Meta's (?:AI )?models|Meta's open model/, ar: /Muse|نماذج ميتا|نموذج ميتا|نماذج الذكاء الاصطناعي من ميتا/ };
        const NAMES_COMMENT = { en: /\bcomment(?:s|ed)?\b/i, ar: /تعليق/ };
        const allowed = { en: [...negations.en, /people who comment or message/gi], ar: negations.ar };
        const sentences = (html: string) => html.split(/<\/(?:li|p|h[1-6])>/).flatMap((chunk) => words(chunk).split(/(?<=[.!?؟])\s+/));
        let checked = 0;
        for (const lang of ['ar', 'en'] as const) {
            for (const [name, doc] of [['privacy', privacy[lang]], ['data-deletion', deletion[lang]], ['terms', terms[lang]]] as const) {
                for (const sentence of sentences(doc)) {
                    if (!NAMES_META_MODELS[lang].test(sentence)) continue;
                    checked++;
                    let rest = sentence;
                    for (const re of allowed[lang]) rest = rest.replace(re, '');
                    assert.ok(!NAMES_COMMENT[lang].test(rest), `${name} ${lang}: a sentence ties Meta's models to comments: ${sentence}`);
                }
            }
        }
        assert.ok(checked > 40, `the scan is not blind: it looked at ${checked} sentences that name Meta's models`);
        // 3. The phrases that only a comment switch would produce, in either language, are nowhere. (Not "read comments" / «قراءة التعليقات»
        //    or "the text of the comment": the TikTok paragraph says no scope lets the app read comments, and section 1 lists the comment
        //    text Meta sends us.)
        const FORBIDDEN = {
            en: /reading of comments|comment reading|comment intent|text of comments|comments? (?:may|can) be read|comment you left|comments? on the account's own post/i,
            ar: /قراءة ميتا للتعليقات|تعليق تركتَه|يقرأ نموذجٌ تعليقاً/,
        };
        for (const lang of ['ar', 'en'] as const) {
            for (const [name, doc] of [['privacy', privacy[lang]], ['data-deletion', deletion[lang]], ['terms', terms[lang]]] as const) {
                const hit = FORBIDDEN[lang].exec(words(doc));
                assert.equal(hit, null, `${name} ${lang}: ${hit?.[0]}`);
            }
        }
        // 4. The scan catches what it is meant to catch.
        assert.ok(FORBIDDEN.en.test('the account has switched on Meta\'s reading of comments') && FORBIDDEN.ar.test('قراءة ميتا للتعليقات'));
        assert.ok(NAMES_META_MODELS.en.test('Meta\'s AI models read the comment') && NAMES_COMMENT.en.test('read the comment') && NAMES_COMMENT.ar.test('نصُّ تعليق'));
    });

    it('section 1 says what is kept of the media a person sent, that the file is not, and that it is off unless switched on', () => {
        has(words(dmList.en),
            'We do not keep a copy of the file itself.',
            'What an AI model understood of what you sent, only where the account has switched that on.',
            'It is for Instagram direct messages only (not Messenger), and off unless it is switched on (section 3).',
            'The file is downloaded, passed to the model and discarded: it is not kept.',
            'What is kept, with your message, is a short description the model wrote of what it showed or, for a voice note, a transcript of what was said, so that the account owner sees it in their inbox and the replies can take it into account.',
            'It is kept for as long as the message text is (section 4), and deleted with your conversation if you ask for it to be erased.',
        );
        has(words(dmList.ar),
            'ولا نحتفظ بنسخة من الملف نفسه.',
            'ما فهمه نموذج ذكاء اصطناعي ممّا أرسلتَه، وذلك فقط إن شغّل الحسابُ هذه الميزة.',
            'وهي للرسائل الخاصة على إنستجرام فقط (لا ماسنجر)، ومتوقفة ما لم تُشغَّل (القسم 3)',
            'يُنزَّل الملف ويُمرَّر إلى النموذج ثم يُتخلَّص منه: لا يُحفَظ.',
            'ويُخزَّن مع رسالتك وصفٌ قصير كتبه النموذج لما ظهر فيه، أو نصُّ ما قيل إن كانت رسالة صوتية، ليراه صاحب الحساب في صندوق رسائله وتأخذه الردود في الحسبان.',
            'ويبقى ما دام نصّ الرسالة باقياً (القسم 4)، ويُحذف مع محادثتك إن طلبتَ حذفها.',
        );
        assert.ok(!words(dmList.en).includes('We do not copy the file itself.'), 'the old sentence is gone: the app does download the file, to pass it on');
    });

    it('section 1 has an h3 for the video library: the owner\'s own reels only, no follower data, watched by Meta\'s models or by Muse Spark Open at Baseten', () => {
        for (const lang of ['ar', 'en'] as const) {
            const doc = privacy[lang];
            const explainers = doc.indexOf(`<h3 id="explainers-${lang}">`);
            const at = doc.indexOf(`<h3 id="reels-${lang}">`);
            const purposes = doc.indexOf(`<h2 id="purposes-${lang}">`);
            assert.ok(explainers > 0 && explainers < at && at < purposes, lang);
            assert.equal((reels[lang].match(/<h2\b/g) ?? []).length, 0, `${lang}: not a new section`);
        }
        has(words(reels.en),
            'This part is about the account owner\'s own published reels, not about anyone who writes to the account.',
            'It uses only the owner\'s own public videos: no comment, message, contact or follower data goes into it.',
            'It is off unless the account owner switches it on.',
            'The watching is done by the AI models Meta runs itself (Muse), or by Meta\'s open model (Muse Spark Open), which our inference partner Baseten runs for us.',
            'No message, comment or follower data goes to Baseten.',
            'The video file is not kept, and the library is kept as section 4 says.',
            'the library\'s notes (not the videos) are sent to Meta\'s AI models together with the text of that message, to find the right one (section 3).',
        );
        has(words(reels.ar),
            'هذا الجزء يخصّ الريلز التي نشرها صاحب الحساب نفسه، لا أي شخص يراسل الحساب.',
            'ولا يدخل فيه إلا فيديوهات صاحب الحساب العلنية: لا بيانات تعليقات ولا رسائل ولا متابعين.',
            'وهو متوقف ما لم يشغّله صاحب الحساب.',
            'وتتم المشاهدة على نماذج ميتا التي تشغّلها بنفسها (Muse)، أو على نموذج ميتا المفتوح (Muse Spark Open) الذي يشغّله لنا شريكنا Baseten.',
            'ولا تصل إلى Baseten أي بيانات عن رسالة أو تعليق أو متابع.',
            'أمّا ملف الفيديو فلا يُحفَظ، وتبقى المكتبة كما يبيّن القسم 4.',
            'تُرسَل ملاحظات المكتبة (لا الفيديوهات) إلى نماذج ميتا مع نصّ تلك الرسالة، لتجد الفيديو المناسب (القسم 3).',
        );
        for (const latin of ['Muse', 'Muse Spark Open', 'Baseten']) assert.ok(reels.ar.includes(`<bdi lang="en" dir="ltr">${latin}</bdi>`), latin);
    });

    it('sections 2, 4 and 5 carry it too: the purpose, the retention of the description and of the library, and Meta\'s line in the list of services', () => {
        has(words(between(privacy.en, '<h2 id="purposes-en">', '<h2 id="gemini-en">')),
            'To understand the photos, videos, voice notes and shared posts you send, so that the reply is about what you actually sent, and, where the account owner has switched on the video library, to find the account owner\'s video that answers your question (section 3).');
        has(words(between(privacy.ar, '<h2 id="purposes-ar">', '<h2 id="gemini-ar">')),
            'فهم الصور ومقاطع الفيديو والرسائل الصوتية والمنشورات المُشارَكة التي ترسلها، ليكون الردّ عمّا أرسلتَه فعلاً، وإيجاد فيديو صاحب الحساب الذي يجيب عن سؤالك إن شغّل مكتبة الفيديوهات (القسم 3).');
        has(words(between(privacy.en, '<h2 id="retention-en">', '<h2 id="processors-en">')),
            'What an AI model understood of the media you sent — the short description, or the transcript of a voice note: kept with your message, so for as long as the message text above. The file itself is not kept.',
            'The video library — the notes about the account owner\'s own published reels: kept with the account, with no automatic expiry. The video files are not kept.');
        has(words(between(privacy.ar, '<h2 id="retention-ar">', '<h2 id="processors-ar">')),
            'ما فهمه نموذج ذكاء اصطناعي ممّا أرسلتَه من وسائط — الوصف القصير، أو نصّ الرسالة الصوتية: يُخزَّن مع رسالتك، فيبقى ما دام نصّ الرسالة أعلاه باقياً. أمّا الملف نفسه فلا يُحفَظ.',
            'مكتبة الفيديوهات — ملاحظات عن الريلز التي نشرها صاحب الحساب نفسه: تبقى مع الحساب بلا مدة انتهاء تلقائية. ولا تُحفَظ ملفات الفيديو.');
        const services = {
            ar: between(privacy.ar, '<h2 id="processors-ar">', '<h3 id="ai-providers-ar">'),
            en: between(privacy.en, '<h2 id="processors-en">', '<h3 id="ai-providers-en">'),
        };
        has(words(item(services.en, '<strong>Meta</strong>')), 'If the operator switches on Meta\'s AI models, Meta also receives, through a separate service used with the operator\'s own key, the text and media described in section 3.');
        has(words(item(services.ar, '<strong>ميتا</strong>')), 'وإن شغّل المُشغّل نماذج ميتا للذكاء الاصطناعي، تتلقّى ميتا كذلك، عبر خدمة منفصلة وبمفتاح المُشغّل، النصوص والوسائط الموصوفة في القسم 3.');
    });

    it('the sub-processor list: Meta (Muse) and Baseten each say what they receive, Meta says Standard only (as Meta states it), Baseten says reels only and nothing about training', () => {
        has(words(item(block.en, '<strong>Meta</strong> (Muse)')),
            'Meta (Muse) — Meta\'s AI models. The same company as the Meta in the list above, but a separate service, used with the operator\'s key.',
            'Where it is switched on it receives what sections 3 and 1 describe: the text of direct messages, the media people send, and the account owner\'s own reels.',
            'Only its Standard models are used, and according to Meta the content they receive is not used to train its models.',
            'Meta\'s privacy policy');
        has(words(item(block.en, '<strong>Baseten</strong>')),
            'Baseten — our inference partner. It runs Meta\'s open model (Muse Spark Open) to watch the account owner\'s own published reels, where the operator has chosen that over the models Meta runs itself.',
            'No message, comment or follower data goes to it.',
            'Baseten\'s privacy policy');
        assert.ok(!/train/i.test(words(item(block.en, '<strong>Baseten</strong>'))), 'Baseten\'s own policy says nothing either way about training, so neither does this page, for Baseten');
        has(words(item(block.ar, '<strong>ميتا</strong>')),
            'ميتا (Muse) — نماذج الذكاء الاصطناعي من ميتا. وهي ميتا نفسها المذكورة في القائمة أعلاه، لكنها خدمة منفصلة تعمل بمفتاح المُشغّل.',
            'وحيث تكون مشغّلة تتلقّى ما يصفه القسمان 3 و1: نصوص الرسائل الخاصة، والوسائط التي يرسلها الناس، وريلز صاحب الحساب نفسه.',
            'ولا تُستخدم إلا نماذجها القياسية (Standard)، والمحتوى الذي تتلقّاه لا يُستخدم، بحسب ميتا، في تدريب نماذجها.',
            'سياسة خصوصية ميتا');
        has(words(item(block.ar, '<strong><bdi lang="en" dir="ltr">Baseten</bdi></strong>')),
            'Baseten — شريكنا في تشغيل النماذج. تشغّل نموذج ميتا المفتوح (Muse Spark Open) ليشاهد ريلز صاحب الحساب نفسه المنشورة، حيث يختار المُشغّل ذلك بدلاً من نماذج ميتا التي تشغّلها بنفسها.',
            'ولا تصل إليها أي بيانات عن رسالة أو تعليق أو متابع.',
            'سياسة خصوصية Baseten');
        assert.ok(!words(item(block.ar, '<strong><bdi lang="en" dir="ltr">Baseten</bdi></strong>')).includes('تدريب'), 'nothing about training for Baseten, in Arabic either');
    });

    it('the sub-processor intro and "what is sent" say what Meta may also receive and that Baseten gets only the reels', () => {
        has(words(block.en),
            'One of them, Meta\'s AI models, can also read the media people send and the account owner\'s own reels, and Baseten runs Meta\'s open model on those reels alone (sections 1 and 3).',
            'except what section 3 says Meta\'s AI models may also receive (the media people send); Baseten receives only the account owner\'s own reels.');
        has(words(block.ar),
            'ومن بينهم نماذج ميتا، وهي تقرأ كذلك الوسائط التي يرسلها الناس وريلز صاحب الحساب نفسه، ويشغّل Baseten نموذج ميتا المفتوح على تلك الريلز وحدها (القسمان 1 و3).',
            'إلا ما يقول القسم 3 إن نماذج ميتا قد تتلقّاه أيضاً (الوسائط التي يرسلها الناس)، ولا يصل إلى Baseten إلا ريلز صاحب الحساب نفسه.');
        // The operator's own address stays the last entry, and the rule that none is used without a key is untouched.
        assert.ok(words(block.en).includes('None of them is used unless the operator has added its key and left it switched on; until then nothing reaches it.'));
    });

    it('Baseten is named on /privacy and /terms only beside the reels: every paragraph or item that names it says so', () => {
        for (const lang of ['ar', 'en'] as const) {
            for (const [name, doc] of [['privacy', privacy[lang]], ['terms', terms[lang]]] as const) {
                const parts = doc.split(/<\/(?:p|li)>/).filter((part) => part.includes('Baseten'));
                assert.ok(parts.length >= 2, `${name} ${lang}: Baseten is named`);
                for (const part of parts) assert.match(words(part), lang === 'ar' ? /ريل/ : /reel/i, `${name} ${lang}: …${words(part).slice(0, 80)}…`);
            }
        }
    });

    describe('/data-deletion', () => {
        const section1 = {
            ar: between(deletion.ar, '<h2>1. ما هو المخزَّن عنك</h2>', '<h2>2. '),
            en: between(deletion.en, '<h2>1. What is stored about you</h2>', '<h2>2. '),
        };
        const section5 = {
            ar: between(deletion.ar, '<h2>5. ما لا يستطيع الحذف الوصول إليه</h2>', '<h2>6. '),
            en: between(deletion.en, '<h2>5. What deletion cannot reach</h2>', '<h2>6. '),
        };

        it('section 1 lists what is stored of the media a person sent, and says it is deleted with the conversation', () => {
            has(words(section1.en),
                'If the account you messaged has switched on reading media with an AI model and you sent a photo, a video or a voice note, or shared a post, reel or story (Instagram only): a short description of it that the model wrote, or, for a voice note, a transcript of what was said, kept with your message. The file itself is not kept. That description or transcript is deleted with your conversation when you ask for it to be deleted (section 2).');
            has(words(section1.ar),
                'إن شغّل الحساب الذي راسلتَه قراءة الوسائط بنموذج ذكاء اصطناعي وأرسلتَ صورة أو مقطع فيديو أو رسالة صوتية، أو شاركتَ منشوراً أو ريلاً أو قصة (على إنستجرام فقط): وصفٌ قصير لها كتبه النموذج، أو نصُّ ما قيل إن كانت رسالة صوتية، يُخزَّن مع رسالتك. أمّا الملف نفسه فلا يُحفَظ. ويُحذف هذا الوصف أو النص مع محادثتك حين تطلب حذفها (القسم 2).');
        });

        it('section 5 has a bullet for Meta\'s AI models, after the AI providers bullet and before the alerts: what may have reached them, that the file is not kept, whose copy is whose', () => {
            for (const lang of ['ar', 'en'] as const) {
                const doc = section5[lang];
                const ai = doc.indexOf(lang === 'ar' ? '<strong>مزوّدو الذكاء الاصطناعي:</strong>' : '<strong>AI providers:</strong>');
                const metaAt = doc.indexOf(lang === 'ar' ? '<strong>نماذج الذكاء الاصطناعي من ميتا' : '<strong>Meta\'s AI models (Muse):</strong>');
                const alerts = doc.indexOf(lang === 'ar' ? '<strong>تنبيهات المُشغّل:</strong>' : '<strong>Alerts to the operator:</strong>');
                assert.ok(ai > 0 && ai < metaAt && metaAt < alerts, lang);
            }
            has(words(item(section5.en, '<strong>Meta\'s AI models (Muse):</strong>')),
                'if the operator has switched on Meta\'s AI models for the account you messaged, the text of your messages, and any photo, video, voice note, or shared post, reel or story you sent may have been processed by them (section 3 of the privacy policy).',
                'We do not keep the file, only a short description or a transcript, which we delete with your conversation.',
                'Meta\'s own copy, if there is one, is governed by Meta\'s policy, and we cannot delete it on your behalf.',
                'According to Meta, what its Standard models receive is not used to train its models, and those are the only ones used.',
                'If you are an account owner, your own published reels may have been watched by Meta\'s models, or by Meta\'s open model at our inference partner Baseten, which receives nothing else; Baseten\'s copy is governed by its own policy too.');
            has(words(item(section5.ar, '<strong>نماذج الذكاء الاصطناعي من ميتا')),
                'إن شغّل المُشغّل هذه النماذج للحساب الذي راسلتَه، فقد تكون نصوص رسائلك، وأي صورة أو مقطع فيديو أو رسالة صوتية أرسلتَها، أو منشور أو ريل أو قصة شاركتَها، قد عولجت بها (القسم 3 من سياسة الخصوصية).',
                'ولا نحتفظ بالملف، بل بوصف قصير أو نص مكتوب فقط، نحذفه مع محادثتك.',
                'ونسخة ميتا نفسها، إن وُجدت، تخضع لسياسة ميتا، ولا نستطيع حذفها نيابةً عنك.',
                'وبحسب ميتا لا يُستخدم ما تتلقّاه نماذجها القياسية (Standard) في تدريب نماذجها، وهذه وحدها المستخدمة.',
                'وإن كنتَ صاحب حساب، فقد تكون ريلزك المنشورة قد شاهدتها نماذج ميتا، أو نموذج ميتا المفتوح لدى شريكنا Baseten الذي لا يتلقّى غيرها؛ ونسخة Baseten تخضع لسياسته هو أيضاً.');
            // The AI providers bullet stays true: it says what else is sent, and defers to the Meta bullet for the exception.
            has(words(section5.en), 'is sent to them, except what the next point describes for Meta\'s AI models.');
            has(words(section5.ar), 'إلا ما تصفه النقطة التالية لنماذج ميتا.');
            for (const latin of ['Muse', 'Standard', 'Baseten']) assert.ok(item(section5.ar, '<strong>نماذج الذكاء الاصطناعي من ميتا').includes(`<bdi lang="en" dir="ltr">${latin}</bdi>`), latin);
        });
    });

    describe('/terms', () => {
        const service = {
            ar: between(terms.ar, '<h2 id="service-ar">', '<h2 id="connecting-ar">'),
            en: between(terms.en, '<h2 id="service-en">', '<h2 id="connecting-en">'),
        };

        it('lists the AI providers in section 2, the same ones as /privacy (Baseten for the account owner\'s own reels only), and points to the list by anchor', () => {
            has(words(service.en),
                'Direct-message replies are written by an AI model, not a person: Google Gemini by default, or another AI provider the operator chooses. The providers are Anthropic (Claude), OpenAI, Google (Gemini), OpenRouter, Groq and Meta (Muse), and Baseten for your own reels only, or a service at an address the operator enters, and the privacy policy says what each one receives.');
            has(words(service.ar),
                'الردود على الرسائل الخاصة يكتبها نموذج ذكاء اصطناعي، لا إنسان: Google Gemini افتراضياً، أو مزوّد ذكاء اصطناعي آخر يختاره المُشغّل. والمزوّدون هم Anthropic (Claude) وOpenAI وجوجل (Gemini) وOpenRouter وGroq وميتا (Muse)، وBaseten لريلزك أنت وحدها، أو خدمة بعنوان يحدّده المُشغّل. وتبيّن سياسة الخصوصية ما يتلقّاه كلٌّ منهم.');
            // The names are /privacy's own list, so the two pages cannot drift apart.
            const names = [...block.en.matchAll(/<li>\s*<strong>([\s\S]*?)<\/strong>/g)].map((m) => words(m[1]!).trim()).slice(0, 7);
            assert.deepEqual(names, ['Anthropic', 'OpenAI', 'Google', 'OpenRouter', 'Groq', 'Meta', 'Baseten']);
            for (const name of names) assert.ok(words(service.en).includes(name), name);
            // The anchors are the ones /privacy keeps (the other tests pin the ids and the contents list).
            assert.ok(service.en.includes('<a href="/privacy#ai-providers-en">privacy policy</a>') && privacy.en.includes('<h3 id="ai-providers-en">'));
            assert.ok(service.ar.includes('<a href="/privacy#ai-providers-ar">سياسة الخصوصية</a>') && privacy.ar.includes('<h3 id="ai-providers-ar">'));
            for (const latin of ['Anthropic', 'Claude', 'OpenAI', 'Gemini', 'OpenRouter', 'Groq', 'Muse', 'Baseten']) assert.ok(service.ar.includes(`<bdi lang="en" dir="ltr">${latin}</bdi>`), latin);
        });

        it('says reading media and watching reels is the account owner\'s switch, and off until it is switched on', () => {
            has(words(service.en),
                'Reads media and watches your reels, only if you switch it on: with Meta\'s AI models switched on for your account, the photos, videos, voice notes and shared posts and stories that people send you can be read, and your own published reels watched, so that the replies are about what people actually sent and to find the right video for a question. Meta\'s models, or Meta\'s open model run for us by Baseten, may watch the reels. All of this is off until you switch it on.');
            has(words(service.ar),
                'قراءة الوسائط ومشاهدة ريلزك، إن شغّلتَ ذلك فقط: إن شغّلتَ نماذج ميتا للذكاء الاصطناعي لحسابك، فقد تُقرأ الصور ومقاطع الفيديو والرسائل الصوتية والمنشورات والقصص المُشارَكة التي يرسلها الناس إليك، وتُشاهَد ريلزك المنشورة، ليكون الردّ عمّا أرسلوه فعلاً ولإيجاد الفيديو المناسب لسؤالهم. وقد تشاهد الريلزَ نماذجُ ميتا أو نموذج ميتا المفتوح الذي يشغّله لنا Baseten. وكل ذلك متوقف إلى أن تشغّله.');
        });

        it('carries the new date in both languages, and the contents list is untouched (no new h2)', () => {
            assert.ok(terms.ar.includes('<time datetime="2026-10-30" dir="ltr">2026-10-30</time>') && terms.en.includes('<time datetime="2026-10-30">2026-10-30</time>'));
            for (const lang of ['ar', 'en'] as const) {
                const doc = terms[lang];
                const toc = /<nav class="toc"[\s\S]*?<\/nav>/.exec(doc)![0];
                assert.deepEqual([...toc.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]), [...doc.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]), lang);
            }
        });
    });
});

describe('both pages — no provider is promised as live', () => {
    for (const p of ['privacy', 'data-deletion', 'terms']) {
        it(`${p}: nothing says "we use Anthropic"; it says what happens if the operator switches one on`, () => {
            const html = noComments(read(`public/${p}.html`));
            // The layer is planned, not live: the owner rules on these pages (no invented claims) are checked by landingTruth's, and this is
            // the one that is new, that no sentence states a provider as in use. Meta (Muse) and Baseten are the newest, and the furthest
            // ahead of their code (hackathon P1), so they are on the list too.
            assert.equal(/we (?:use|send to|rely on) (?:Anthropic|OpenAI|OpenRouter|Groq|Baseten|Meta's AI|Muse)/i.test(words(html)), false);
        });
    }
});
