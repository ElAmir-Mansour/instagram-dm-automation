/**
 * The AI providers named as sub-processors on /privacy and /data-deletion (P20d), in both languages.
 *
 * Meta, TikTok and Google reviewers and the account owners themselves read these pages, so each sentence is a claim about the product.
 * The AI providers layer is planned, not live (DESIGN.md §9's truth table), so what is pinned is the shape of an honest disclosure:
 *
 *   - the six names (Anthropic, OpenAI, Google (Gemini), OpenRouter, Groq, and an address the operator enters), in both languages, in the same order;
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
 *     alert cannot drift apart.
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

    it('lists the same six, in the same order, in Arabic and English', () => {
        const names = (html: string) => [...html.matchAll(/<li>\s*<strong>([\s\S]*?)<\/strong>/g)].map((m) => words(m[1]!).trim());
        const ar = names(block.ar);
        const en = names(block.en);
        assert.equal(ar.length, 6);
        assert.equal(en.length, 6);
        assert.deepEqual(en, ['Anthropic', 'OpenAI', 'Google', 'OpenRouter', 'Groq', 'A service at an address the operator enters']);
        assert.deepEqual(ar.slice(0, 5), ['Anthropic', 'OpenAI', 'جوجل', 'OpenRouter', 'Groq']);
        assert.equal(ar[5], 'خدمة بعنوان يحدّده المُشغّل');
        assert.ok(words(block.ar).includes('Gemini') && words(block.en).includes('Gemini'));
        assert.ok(words(block.en).includes('OpenAI-compatible'));
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
        assert.ok(privacy.ar.includes('آخر تحديث: 25 أكتوبر 2026') && privacy.en.includes('Last updated: 25 October 2026'));
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

    it('names the five providers and the operator\'s own address, scopes it to account owners, and says the copy is theirs', () => {
        const en = words(section5.en);
        for (const name of ['Anthropic', 'OpenAI', 'Google (Gemini)', 'OpenRouter', 'Groq', 'a service at an address the operator added']) assert.ok(en.includes(name), name);
        assert.ok(en.includes('if you are an account owner and the operator of the tool has switched on a provider'));
        assert.ok(en.includes('we cannot delete it on your behalf'));
        assert.ok(en.includes('the text of your conversation reached that provider instead of Google (section 3 of the privacy policy)'));
        assert.ok(en.includes('Nothing else about people who comment or message on Instagram or Facebook is sent to them'));
        const ar = words(section5.ar);
        for (const name of ['Anthropic', 'OpenAI', 'Gemini', 'OpenRouter', 'Groq']) assert.ok(ar.includes(name), name);
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
        assert.ok(deletion.ar.includes('آخر تحديث: 25 أكتوبر 2026') && deletion.en.includes('Last updated: 25 October 2026'));
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

describe('both pages — no provider is promised as live', () => {
    for (const p of ['privacy', 'data-deletion']) {
        it(`${p}: nothing says "we use Anthropic"; it says what happens if the operator switches one on`, () => {
            const html = noComments(read(`public/${p}.html`));
            // The layer is planned, not live: the owner rules on these pages (no invented claims) are checked by landingTruth's, and this is
            // the one that is new, that no sentence states a provider as in use.
            assert.equal(/we (?:use|send to|rely on) (?:Anthropic|OpenAI|OpenRouter|Groq)/i.test(words(html)), false);
        });
    }
});
