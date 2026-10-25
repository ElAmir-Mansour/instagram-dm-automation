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
 * WhatsApp (docs/specs/001-whatsapp-agent, T056) is pinned below in both languages, on /privacy, /data-deletion and /terms:
 *
 *   - WhatsApp is a channel: what is collected (the WhatsApp name, the phone number or the Meta user ID, the text, the files), "less may be stored,
 *     never more", Meta's WhatsApp Cloud API as a processor that keeps a message for up to 30 days;
 *   - the AI providers: replies come from Groq, Anthropic or OpenAI ONLY and never Google, because their terms say they do not train on what they are
 *     sent (the page's list is compared with `NO_TRAINING_PROVIDERS` in code, so it cannot drift); a voice note is transcribed by Groq ALONE today,
 *     because the only caller never allows the paid provider (a test reads `ALLOW_PAID_TRANSCRIPTION`, so naming OpenAI again is forced, not forgotten);
 *   - the operator's alerts (section 3's) apply on WhatsApp too, naming the person by their WhatsApp name;
 *   - opt-out by writing «إيقاف» / "stop" (the code's own matcher is asked), a person on request, deletion (private files included), what
 *     deletion cannot reach, and the one thing a deletion KEEPS: the record of a request to stop (a test reads erasure.ts and the v50 schema).
 *
 * Re-verified on 2026-10-25 against the wired pipeline: files are saved and voice notes transcribed for the people stored in full (the block at the
 * top of public/privacy.html cites each step), and the page says "may" and "can" where who is stored in full or answered is the owner's setting.
 *
 * The pages' bodies are otherwise untouched by this change, so the existing checks on them (publicPagesFiles, publicPagesChrome,
 * landingTruth's owner rules) are what say the rest is still true.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { NO_TRAINING_PROVIDERS, PURPOSE_PROVIDER_ALLOWLIST } from './aiProviders/purposes.js';
import { PRIVATE_MEDIA_ORPHAN_DAYS } from './retention.js';
import { TRANSCRIBE_PROVIDERS } from './transcribe.js';
import { matchStopMessage } from './consent.js';
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
        assert.ok(en.includes('It names you by your username (on WhatsApp, your WhatsApp name), or, if we have none, by the last four characters of your account ID, and quotes up to 200 characters of the last message you wrote, with any link in it replaced by “[link]”.'));
        assert.ok(en.includes('It also says why a person is needed, how long Meta\'s reply window has left, and links to the conversation in the dashboard.'));
        const ar = section3.ar;
        assert.ok(ar.includes('قد يُنبَّه مُشغّل الأداة (القسم 9) إذا تعذّرت كتابة ردّ على رسالتك (عطل تقني)'));
        assert.ok(ar.includes('وكذلك في وضع المبيعات حين يحوّل المساعد محادثتك إلى شخص (كأن تطلب التحدّث إلى شخص أو استرجاع مالك أو تشتكي)، أو حين يرسل إليك الرابط بعد أن سألت عن الشراء أو عن السعر أو عن مناسبته لك.'));
        assert.ok(ar.includes('ولا يحدث ذلك إلا في المحادثات مع حسابه هو، وإلا إن فعّل التنبيهات.'));
        assert.ok(ar.includes('والتنبيه رسالة على تيليجرام و/أو بريد إلكتروني يُرسَل عبر Resend (القسم 5).'));
        assert.ok(ar.includes('يُذكر فيه اسم المستخدم الخاص بك (وعلى واتساب اسمك على واتساب)، أو آخر أربعة أحرف من معرّف حسابك إن لم يكن لدينا اسم لك، وما يصل إلى 200 حرف من آخر رسالة كتبتَها، وتُستبدَل الروابط فيها بـ«[link]».'));
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
        assert.ok(en.includes('Resend — sends the alert emails, when they are switched on: the alerts about a conversation that needs a person, described in section 3, which carry your username or your WhatsApp name (or the last four characters of your account ID) and up to 200 characters of your last message, and the ads alerts in section 1.'));
        assert.ok(en.includes('Telegram — delivers the same alerts as Telegram messages, to the chat set in Settings, when they are switched on.'));
        const ar = words(services.ar);
        assert.ok(ar.includes('Resend — يرسل رسائل التنبيه بالبريد الإلكتروني حين تكون مفعّلة: تنبيهات المحادثة التي تحتاج إلى شخص الموصوفة في القسم 3، وفيها اسم المستخدم الخاص بك أو اسمك على واتساب (أو آخر أربعة أحرف من معرّف حسابك) وما يصل إلى 200 حرف من آخر رسالة كتبتَها، وتنبيهات الإعلانات الموصوفة في القسم 1.'));
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
        assert.ok(en.includes('an alert sent to him by Telegram and/or by email through Resend may have carried your username or WhatsApp name (or the last four characters of your account ID) and up to 200 characters of your last message (section 3 of the privacy policy)'));
        assert.ok(en.includes('Those copies are in his Telegram chat and mailbox, and Telegram\'s and Resend\'s copies are governed by their own policies; deleting your data here does not reach them.'));
        const ar = words(section5.ar);
        assert.ok(ar.includes('فقد يكون تنبيهٌ أُرسل إليه على تيليجرام و/أو بالبريد الإلكتروني عبر Resend قد ذكر اسم المستخدم الخاص بك أو اسمك على واتساب (أو آخر أربعة أحرف من معرّف حسابك) وما يصل إلى 200 حرف من آخر رسالة كتبتَها (القسم 3 من سياسة الخصوصية)'));
        assert.ok(ar.includes('وحذف بياناتك هنا لا يصل إليها.'));
    });

    it('the page\'s numbers are the alert\'s own: 200 characters with links replaced, the @username or the last four characters of the id, sent to Telegram and Resend', () => {
        const cut = excerpt('a'.repeat(300));
        assert.equal(Array.from(cut).length, 201, '200 characters kept, then the ellipsis');
        assert.ok(cut.startsWith('a'.repeat(200)) && cut.endsWith('…'));
        assert.equal(excerpt('see https://example.com/page now'), 'see [link] now');
        assert.equal(noticeWho({ lang: 'en', username: null, senderId: '17841400000001234', platform: 'instagram' }), 'Instagram user …1234');
        assert.equal(noticeWho({ lang: 'en', username: 'someone', senderId: '17841400000001234', platform: 'instagram' }), '@someone');
        // WhatsApp: the profile name (handoff.ts passes it as `username`), never an @; with none, the last four characters of the BSUID.
        assert.equal(noticeWho({ lang: 'en', username: 'Karim', senderId: 'US.13491208655302741918', platform: 'whatsapp' }), 'Karim');
        assert.equal(noticeWho({ lang: 'en', username: null, senderId: 'US.13491208655302741918', platform: 'whatsapp' }), 'WhatsApp user …1918');
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
    for (const p of ['privacy', 'data-deletion', 'terms']) {
        it(`${p}: nothing says "we use Anthropic"; it says what happens if the operator switches one on`, () => {
            const html = noComments(read(`public/${p}.html`));
            // The layer is planned, not live: the owner rules on these pages (no invented claims) are checked by landingTruth's, and this is
            // the one that is new, that no sentence states a provider as in use.
            assert.equal(/we (?:use|send to|rely on) (?:Anthropic|OpenAI|OpenRouter|Groq)/i.test(words(html)), false);
        });
    }
});


// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// WhatsApp (T056)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the page calls each provider. The code's ids are the lower-case of these. */
const PROVIDER_NAME: Readonly<Record<string, string>> = { groq: 'Groq', anthropic: 'Anthropic', openai: 'OpenAI' };

/** The WhatsApp sub-section of /privacy section 1: from its h3 to TikTok's, which follows it. */
const waSection = {
    ar: between(privacy.ar, '<h3 id="whatsapp-ar">', '<h3>عندما يربط صاحب الحساب تيك توك</h3>'),
    en: between(privacy.en, '<h3 id="whatsapp-en">', '<h3>When the account owner connects TikTok</h3>'),
};
/** Section 3 of /privacy. */
const geminiSection = {
    ar: between(privacy.ar, '<h2 id="gemini-ar">', '<h2 id="retention-ar">'),
    en: between(privacy.en, '<h2 id="gemini-en">', '<h2 id="retention-en">'),
};
/** Section 4 of /privacy. */
const retentionSection = {
    ar: between(privacy.ar, '<h2 id="retention-ar">', '<h2 id="processors-ar">'),
    en: between(privacy.en, '<h2 id="retention-en">', '<h2 id="processors-en">'),
};
/** Section 5 of /privacy, before the AI providers' h3: the list of services. */
const servicesSection = {
    ar: between(privacy.ar, '<h2 id="processors-ar">', '<h3 id="ai-providers-ar">'),
    en: between(privacy.en, '<h2 id="processors-en">', '<h3 id="ai-providers-en">'),
};

describe('/privacy — WhatsApp is named as a channel, in both languages (FR-028)', () => {
    it('is an h3 inside section 1, after the direct-message block and before TikTok, with the id the go-live gate can look for', () => {
        for (const lang of ['ar', 'en'] as const) {
            const doc = privacy[lang];
            const collected = doc.indexOf(`<h2 id="collected-${lang}">`);
            const dm = doc.indexOf(lang === 'ar' ? '<h3>عندما ترسل رسالة خاصة</h3>' : '<h3>When you send a direct message</h3>');
            const wa = doc.indexOf(`<h3 id="whatsapp-${lang}">`);
            const purposes = doc.indexOf(`<h2 id="purposes-${lang}">`);
            assert.ok(collected > 0 && collected < dm && dm < wa && wa < purposes, lang);
            assert.equal((waSection[lang].match(/<h2\b/g) ?? []).length, 0, `${lang}: a subsection, not a new section`);
        }
    });

    it('names the channel at the top: the page applies to WhatsApp, and the owner can connect a number', () => {
        assert.ok(words(privacy.en).includes('its integrations with Instagram, Facebook, WhatsApp, TikTok and YouTube'));
        assert.ok(words(privacy.en).includes('if the owner connects a WhatsApp number, the messages sent to that number'));
        assert.ok(words(privacy.ar).includes('مع إنستجرام وفيسبوك وواتساب وتيك توك ويوتيوب'));
        assert.ok(words(privacy.ar).includes('وعلى رسائل واتساب الواردة إلى رقمه إن ربط رقماً'));
    });

    it('says what Meta delivers with a message and what is stored about the person, voice notes and images included', () => {
        const en = words(waSection.en);
        assert.ok(en.includes('the name on your WhatsApp profile'));
        assert.ok(en.includes('the identifiers Meta gives this business for you (business-scoped user IDs)'), 'a parent BSUID too, when the business is enrolled');
        assert.ok(en.includes('your phone number if Meta shares it with us'));
        assert.ok(en.includes('Stored about you: your WhatsApp name, your phone number if it came, your Meta user IDs'));
        assert.ok(en.includes('and the automated assistant may answer them, as section 3 describes'), 'only the people the owner set it up for are answered');
        assert.ok(en.includes('It contains all of the above, and anything else the message carried, such as a location or a contact card you shared, so it is a second copy of it.'));
        assert.ok(en.includes('download the file itself from Meta (a voice note, photo, video or document, not a sticker)'));
        assert.ok(en.includes('The text of your message as you wrote it'));
        assert.ok(en.includes('The verbatim event Meta sent us, in full.'));
        assert.ok(en.includes('If your message is a voice note, photo, video, sticker or document'));
        assert.ok(en.includes('keep a private copy of it with the conversation: in a non-public storage area at Supabase, never served from a public address'));
        const ar = words(waSection.ar);
        assert.ok(ar.includes('اسمك في ملفك على واتساب'));
        assert.ok(ar.includes('معرّفات مستخدم واتساب الخاصة بالنشاط'));
        assert.ok(ar.includes('ورقم هاتفك إن شاركته ميتا معنا'));
        assert.ok(ar.includes('يُخزَّن عنك: اسمك على واتساب، ورقم هاتفك إن وصل، ومعرّفاتك عند ميتا'));
        assert.ok(ar.includes('وقد يردّ عليها المساعد الآلي كما يوضّح القسم 3'));
        assert.ok(ar.includes('يحتوي على ما سبق كلّه، وعلى أي شيء آخر حملته الرسالة، كموقع أو بطاقة جهة اتصال شاركتَها، فهو نسخة ثانية منه.'));
        assert.ok(ar.includes('(المقطع الصوتي أو الصورة أو الفيديو أو المستند، لا الملصق)'));
        assert.ok(ar.includes('نصّ رسالتك كما كتبته'));
        assert.ok(ar.includes('الحدث الأصلي كما ورد من ميتا، حرفياً وبالكامل.'));
        assert.ok(ar.includes('إن كانت رسالتك مقطعاً صوتياً أو صورة أو فيديو أو ملصقاً أو مستنداً'));
        assert.ok(ar.includes('في مساحة تخزين غير علنية لدى Supabase، لا يُقدَّم الملف من أي عنوان علني'));
    });

    it('says less may be stored and never more (the code stores only a listed tester in full), without naming who, so it stays true after go-live', () => {
        assert.ok(words(waSection.en).includes('Less than this may be stored, depending on how the account owner has set the WhatsApp assistant up'));
        assert.ok(words(waSection.en).includes('but never more.'));
        assert.ok(words(waSection.ar).includes('وقد يُخزَّن أقلّ من ذلك بحسب ما ضبطه صاحب الحساب لمساعد واتساب'));
        assert.ok(words(waSection.ar).includes('لكن لا يُخزَّن أكثر من ذلك أبداً.'));
        // A stranger's thread keeps how it began (entry_source is metadata, recorded for everyone), so the example says so.
        assert.ok(words(waSection.en).includes('only that a message arrived, when, of what type, how the conversation began, and the sender\'s Meta user ID'));
        assert.ok(words(waSection.ar).includes('أن رسالة وصلت ووقتها ونوعها وكيف بدأت المحادثة ومعرّف مرسلها عند ميتا'));
    });

    it('no longer says a phone number is never received: on Instagram and Facebook it is not, on WhatsApp it is', () => {
        const en = words(between(privacy.en, '<h3>When you send a direct message</h3>', '<h3 id="whatsapp-en">'));
        assert.equal(en.includes('email address, phone number'), false, 'the old, absolute sentence is gone');
        assert.ok(en.includes('your phone number does not reach us from Instagram or Facebook; on WhatsApp it is part of what Meta delivers to us'));
        const ar = words(between(privacy.ar, '<h3>عندما ترسل رسالة خاصة</h3>', '<h3 id="whatsapp-ar">'));
        assert.equal(ar.includes('أو رقم هاتفك أو عنوانك'), false);
        assert.ok(ar.includes('ولا يصلنا رقم هاتفك من إنستجرام أو فيسبوك؛ أمّا على واتساب فرقمك جزء ممّا تسلّمه ميتا إلينا'));
    });

    it('says who reads it, and that section 3\'s alerts apply, with a WhatsApp name and a reply that could not be sent', () => {
        const en = words(waSection.en);
        assert.ok(en.includes('The account owner reads the conversation in the inbox of their dashboard and can reply to it by hand.'));
        assert.ok(en.includes('The alerts section 3 describes apply here too (on WhatsApp the assistant always works as in sales mode), and also when a reply to you could not be sent'));
        assert.ok(en.includes('they name you by your WhatsApp name or username (or the last four characters of your ID if there is neither) and quote up to 200 characters of the last thing you wrote, with links replaced by “[link]”. They travel through Telegram and Resend (section 5).'));
        const ar = words(waSection.ar);
        assert.ok(ar.includes('يقرأ صاحب الحساب المحادثة في صندوق رسائله بلوحة التحكم، ويستطيع الردّ عليها بنفسه.'));
        assert.ok(ar.includes('وتسري هنا التنبيهات الموصوفة في القسم 3 (فالمساعد على واتساب يعمل دائماً كما في وضع المبيعات)، وكذلك حين يتعذّر إرسال ردّ إليك'));
        assert.ok(ar.includes('يُذكر فيها اسمك على واتساب أو اسم المستخدم (أو آخر أربعة أحرف من معرّفك إن لم يكن لك أيٌّ منهما)، وما يصل إلى 200 حرف من آخر ما كتبتَه، وتُستبدَل الروابط فيه بـ«[link]». وتمرّ عبر تيليجرام وResend (القسم 5).'));
        // The old paragraph's "the account owner may be alerted": it is the operator, and only for his own account (section 3).
        assert.equal(en.includes('an alert may reach them by email or on Telegram'), false);
    });

    it('says how to stop the messages: «إيقاف» or "stop" on its own, which the code\'s matcher takes; no more replies or follow-ups; a confirmation only when the assistant is answering', () => {
        const en = words(waSection.en);
        assert.ok(en.includes('To stop the messages: write «إيقاف» or “stop” on its own in a message.'));
        assert.ok(en.includes('The assistant then stops replying in that conversation and sends you no follow-ups, and, if it is the one answering you at the time, confirms this once, in one line. Your request is recorded (section 4).'));
        const ar = words(waSection.ar);
        assert.ok(ar.includes('لإيقاف الرسائل: اكتب «إيقاف» أو stop وحدها في رسالة.'));
        assert.ok(ar.includes('عندها يتوقّف المساعد عن الردّ في هذه المحادثة ولا يرسل لك متابعات بعد ذلك، ويؤكّد ذلك مرة واحدة بسطر واحد إن كان هو من يردّ عليك حينها. ويُسجَّل طلبك هذا (القسم 4).'));
        // The words the page tells people to write are the matcher's own, and so is «توقف», which section 1's ads text tells them to write.
        for (const phrase of ['إيقاف', 'stop', 'توقف', 'STOP']) assert.ok(matchStopMessage(phrase), phrase);
        assert.equal(matchStopMessage('please stop by tomorrow'), null, 'a sentence is not a stop');
    });

    it('lists the short-link counting without repeating the Instagram list item the other checks locate by its words', () => {
        assert.ok(words(waSection.en).includes('The short links in replies (/r/…) work here as described above for Instagram direct messages'));
        assert.equal(waSection.en.includes('Link-click counting'), false);
        assert.equal(waSection.ar.includes('عدّ النقرات على الروابط'), false);
    });
});

describe('/privacy — the AI providers that may read WhatsApp messages, and the no-training rule (FR-028)', () => {
    /** The providers a clause names, in the page's own words, lower-cased to the code's ids. */
    const named = (clause: string, separator: RegExp): string[] => clause.split(separator).map((s) => s.trim().toLowerCase()).filter(Boolean);

    it('says WhatsApp messages are never sent to Google, and that Gemini does not write the reply when the provider cannot', () => {
        const en = words(geminiSection.en);
        assert.ok(en.includes('WhatsApp messages are never sent to Google.'));
        assert.ok(en.includes('and WhatsApp messages are not sent to Google, to OpenRouter, or to a service at an address the operator enters, even if one is switched on'));
        assert.ok(en.includes('If the provider cannot answer, Gemini does not write the reply instead; the conversation is handed to the account owner.'));
        assert.ok(en.includes('That is so on Instagram and Facebook; WhatsApp messages are never sent to Google (below).'));
        const ar = words(geminiSection.ar);
        assert.ok(ar.includes('رسائل واتساب لا تذهب إلى جوجل إطلاقاً.'));
        assert.ok(ar.includes('ولا تُرسَل رسائل واتساب إلى جوجل ولا إلى OpenRouter ولا إلى خدمة بعنوان يضيفه المُشغّل، ولو فُعِّلت'));
        assert.ok(ar.includes('لا يكتب «جيميناي» الردّ بدلاً منه، بل تُحوَّل المحادثة إلى صاحب الحساب.'));
        assert.ok(ar.includes('هذا على إنستجرام وفيسبوك؛ أمّا رسائل واتساب فلا تُرسَل إلى جوجل إطلاقاً (أدناه).'));
    });

    it('names Groq, Anthropic and OpenAI as the only writers, and that is the code\'s allow-list: the page cannot drift from it', () => {
        const en = /written only by ([^—]+?) —/.exec(words(geminiSection.en))?.[1];
        const ar = /ردودها يكتبها (.+?) فقط/.exec(words(geminiSection.ar))?.[1];
        assert.ok(en && ar, 'both clauses are there');
        const fromEn = named(en!, /,|\bor\b/);
        const fromAr = named(ar!, /\sأو\s/);
        const wanted = [...NO_TRAINING_PROVIDERS].sort();
        assert.deepEqual([...fromEn].sort(), wanted, 'English names exactly the providers WhatsApp may use');
        assert.deepEqual([...fromAr].sort(), wanted, 'Arabic names exactly the same');
        for (const id of wanted) assert.ok(PROVIDER_NAME[id], `${id} has a name on the page`);
        // The route is refused for every other provider, in code: the page's "never Google, OpenRouter or an address" is its consequence.
        assert.deepEqual([...(PURPOSE_PROVIDER_ALLOWLIST.dm_whatsapp ?? [])].sort(), wanted);
        for (const refused of ['gemini', 'openrouter', 'custom']) assert.equal((NO_TRAINING_PROVIDERS as readonly string[]).includes(refused), false, refused);
    });

    it('states the no-training reason in both languages, as the rule WhatsApp messages are limited by, not as a promise about the providers', () => {
        assert.ok(words(geminiSection.en).includes('the providers WhatsApp messages are limited to because the terms of their APIs say they do not train their models on what is sent to them (their policies are linked in section 5)'));
        assert.ok(words(geminiSection.ar).includes('وهي الجهات التي نقصر عليها رسائل واتساب لأن شروط واجهاتها البرمجية تنصّ على ألّا تدرّب نماذجها على ما يُرسَل إليها (سياساتها في القسم 5)'));
    });

    it('says what is sent: up to twelve messages with their direction, notes on the conversation, and no name, number, ID or conversation ID', () => {
        const en = words(geminiSection.en);
        assert.ok(en.includes('What is sent is the text of your message and up to the last twelve messages in the thread, with the direction of each, and notes about the conversation itself (such as whether you have already been sent a link, or which button you tapped); your WhatsApp name, your phone number, your ID and the conversation ID are not sent.'));
        assert.equal(en.includes('What is sent is what the previous paragraph describes'), false, 'the previous paragraph names a comment keyword and an ad, which WhatsApp does not send');
        const ar = words(geminiSection.ar);
        assert.ok(ar.includes('وما يُرسَل هو نصّ رسالتك وما يصل إلى آخر اثنتي عشرة رسالة من المحادثة، مع اتجاه كل رسالة، وملاحظات عن المحادثة نفسها (كأن يُذكر هل أُرسل إليك رابط من قبل، أو أيّ زرّ ضغطت)'));
        assert.ok(ar.includes('ولا يُرسَل اسمك على واتساب ولا رقم هاتفك ولا معرّفك ولا معرّف المحادثة.'));
    });

    it('says a voice note is turned into text by Groq alone, which is what the code does: OpenAI is on the allow-list but its only caller never allows it', () => {
        // The allow-list is Groq, then OpenAI; OpenAI is the paid one and is used only when the caller allows paid AI, and the one caller does not.
        assert.deepEqual([...TRANSCRIBE_PROVIDERS], ['groq', 'openai']);
        const caller = read('src/webhook/whatsappMediaInput.ts');
        assert.ok(caller.includes('const ALLOW_PAID_TRANSCRIPTION = false;'), 'when this flips, the page must name OpenAI again (sections 3 and 5, /data-deletion section 5)');
        assert.ok(caller.includes('allowPaid: ALLOW_PAID_TRANSCRIPTION'));
        const en = words(geminiSection.en);
        assert.ok(en.includes('Voice notes: when a voice note is turned into text so that it can be answered, the audio is sent to Groq (its Whisper speech model) and to no one else.'));
        assert.ok(en.includes('The text it produces is treated as if you had typed it.'));
        const ar = words(geminiSection.ar);
        assert.ok(ar.includes('المقاطع الصوتية: حين يُحوَّل مقطع صوتي إلى نصّ ليُجاب عنه، يُرسَل الصوت إلى Groq (نموذج Whisper للتعرّف على الكلام)، ولا يُرسَل إلى أي جهة أخرى.'));
        // The old wording paired the two for transcription ("Groq or OpenAI"); the replies' three are always "Groq, Anthropic or OpenAI".
        for (const doc of [privacy.en, deletion.en]) assert.equal(words(doc).includes('Groq or OpenAI'), false, 'no sentence still says OpenAI transcribes');
        for (const doc of [privacy.ar, deletion.ar]) assert.equal(words(doc).includes('Groq أو OpenAI'), false, 'no sentence still says OpenAI transcribes');
    });

    it('says a person is available on request, in sales mode and on WhatsApp only (the default Gemini path has no hand-off), and that the first reply says it is automated', () => {
        assert.ok(words(geminiSection.en).includes('In sales mode and on WhatsApp, if you ask for a person, the assistant is built to stop replying and hand the conversation to the account owner.'));
        assert.ok(words(geminiSection.ar).includes('وفي وضع المبيعات وعلى واتساب، إن طلبتَ التحدّث إلى شخص، فالمساعد مصمَّم على أن يتوقّف عن الردّ وتُحوَّل المحادثة إلى صاحب الحساب.'));
        assert.ok(words(geminiSection.en).includes('the first message in a thread — and another one after a long gap — tells you that you are talking to an automated service'));
    });

    it('repeats the rule in the sub-processor block, with no link of its own and no provider promised as live', () => {
        const en = words(block.en);
        assert.ok(en.includes('WhatsApp messages: only Groq, Anthropic or OpenAI writes their replies, and only Groq turns their voice notes into text (section 3); nothing from them reaches Google, OpenRouter or a service at an address the operator enters.'));
        const ar = words(block.ar);
        assert.ok(ar.includes('رسائل واتساب: لا يكتب ردودَها إلا Groq أو Anthropic أو OpenAI، ولا يحوّل مقاطعها الصوتية إلى نصّ إلا Groq (القسم 3)'));
        assert.ok(ar.includes('ولا يصل شيء منها إلى جوجل ولا إلى OpenRouter ولا إلى خدمة بعنوان يضيفه المُشغّل.'));
    });
});

describe('/privacy — Meta as WhatsApp processor, Resend and Telegram for the owner\'s alerts, retention and deletion (FR-018, FR-029)', () => {
    const links = (doc: string): string[] => [...doc.matchAll(/<a\b([^>]*)>/g)].map((m) => /href="([^"]+)"/.exec(m[1]!)?.[1] ?? '');
    const li = (doc: string, marker: string): string => {
        const at = doc.indexOf(marker);
        assert.ok(at >= 0, marker);
        return doc.slice(doc.lastIndexOf('<li>', at), doc.indexOf('</li>', at));
    };
    const RESEND = { ar: '<bdi lang="en" dir="ltr">Resend</bdi></strong>', en: '<strong>Resend</strong>' };
    const TELEGRAM = { ar: '<strong>تيليجرام</strong>', en: '<strong>Telegram</strong>' };

    it('lists Meta (WhatsApp Cloud API) as a processor that keeps a message at most 30 days, and manages the keys, as Meta\'s documentation says', () => {
        const en = words(li(servicesSection.en, '<strong>Meta — WhatsApp</strong>'));
        assert.ok(en.includes('Meta — WhatsApp (WhatsApp Cloud API) — WhatsApp messages arrive from it, and replies are sent back through it.'));
        assert.ok(en.includes('Meta acts as a data processor here; its documentation says a message is kept by it for at most 30 days'));
        assert.ok(en.includes('its API manages the encryption and decryption keys on the business\'s behalf'));
        const ar = words(li(servicesSection.ar, '<strong>ميتا — واتساب</strong>'));
        assert.ok(ar.includes('تعمل ميتا هنا جهةَ معالجة للبيانات'));
        assert.ok(ar.includes('يُحتفَظ بها لديها مدة أقصاها 30 يوماً'));
        assert.ok(ar.includes('واجهتها هي التي تدير مفاتيح التشفير وفكّه نيابةً عن النشاط'));
        for (const lang of ['ar', 'en'] as const) {
            const marker = lang === 'ar' ? '<strong>ميتا — واتساب</strong>' : '<strong>Meta — WhatsApp</strong>';
            assert.deepEqual(links(li(servicesSection[lang], marker)), [
                'https://developers.facebook.com/documentation/business-messaging/whatsapp/data-privacy-and-security',
                'https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform',
            ], lang);
        }
    });

    it('lists Resend and Telegram, with their policies, as where the owner\'s alert passes (their words are pinned with the alerts above)', () => {
        for (const lang of ['ar', 'en'] as const) {
            assert.deepEqual(links(li(servicesSection[lang], RESEND[lang])), ['https://resend.com/legal/privacy-policy'], lang);
            assert.deepEqual(links(li(servicesSection[lang], TELEGRAM[lang])), ['https://telegram.org/privacy'], lang);
        }
    });

    it('opens every outbound link in the services list safely', () => {
        for (const lang of ['ar', 'en'] as const) {
            for (const attrs of [...servicesSection[lang].matchAll(/<a\b([^>]*)>/g)].map((m) => m[1]!)) {
                if (/href="https?:/.test(attrs)) assert.match(attrs, /target="_blank" rel="noopener noreferrer"/, `${lang}: ${attrs}`);
            }
        }
    });

    it('says in section 4 how long the event, the queue rows and the files are kept, and the files\' number is the code\'s', () => {
        assert.equal(PRIVATE_MEDIA_ORPHAN_DAYS, 30);
        const en = words(retentionSection.en);
        assert.ok(en.includes('WhatsApp — the verbatim event and the queue rows: what is said above applies to them.'));
        assert.ok(en.includes('the event in its queue row is cut down when its processing ends to IDs, the message type and its time, with no text, name or number'));
        assert.ok(en.includes(`WhatsApp — files: a file you send, if a copy of it was kept, stays as long as a message in the conversation points to it, and is deleted with the conversation. A file that no message points to is deleted ${PRIVATE_MEDIA_ORPHAN_DAYS} days after it was saved.`));
        assert.ok(en.includes('This includes the text of your private messages, and on WhatsApp your name, phone number and ID as well.'));
        const ar = words(retentionSection.ar);
        assert.ok(ar.includes('واتساب — الحدث الأصلي وصفوف الطابور: يسري عليهما ما سبق.'));
        assert.ok(ar.includes('بلا نصّ ولا اسم ولا رقم'));
        assert.ok(ar.includes(`وملف لا تشير إليه أي رسالة يُحذف بعد ${PRIVATE_MEDIA_ORPHAN_DAYS} يوماً من حفظه`));
        assert.ok(ar.includes('وعلى واتساب يشمل كذلك اسمك ورقم هاتفك ومعرّفك.'));
    });

    it('points WhatsApp deletion to the deletion page, and says the WhatsApp token is encrypted and files are not end-to-end encrypted', () => {
        const deletionSection = {
            en: words(between(privacy.en, '<h2 id="deletion-en">', '<h2 id="security-en">')),
            ar: words(between(privacy.ar, '<h2 id="deletion-ar">', '<h2 id="security-ar">')),
        };
        assert.ok(deletionSection.en.includes('That includes your conversations on WhatsApp and any files kept from them.'));
        assert.ok(deletionSection.ar.includes('ويشمل ذلك محادثاتك على واتساب وما حُفظ منها من ملفات.'));
        const security = {
            en: words(between(privacy.en, '<h2 id="security-en">', '<h2 id="changes-en">')),
            ar: words(between(privacy.ar, '<h2 id="security-ar">', '<h2 id="changes-ar">')),
        };
        assert.ok(security.en.includes("The account owner's Meta access token, their ads access token if there is one, their WhatsApp access token, and their TikTok and YouTube access and refresh tokens, are encrypted before they are stored"));
        assert.ok(security.en.includes('files received on WhatsApp, if kept, are not end-to-end encrypted either.'));
        assert.ok(security.ar.includes('ورمز وصول واتساب'));
        assert.ok(security.ar.includes('والملفات الواردة من واتساب، إن حُفظت، ليست مشفّرة من طرف إلى طرف كذلك.'));
    });

    it('lists WhatsApp among the purposes (answering the person; the alert is section 3\'s own purpose, listed once)', () => {
        assert.ok(words(privacy.en).includes('To answer you if you message a WhatsApp number the account owner connected.'));
        assert.ok(words(privacy.ar).includes('الردّ على رسائلك إن راسلتَ رقماً على واتساب ربطه صاحب الحساب.'));
        assert.ok(words(privacy.en).includes('To alert the operator of the tool when a conversation with his own account needs a person (section 3).'));
    });

    it('says in section 4 that a request to stop is kept, also after a deletion, which is what the schema and the erasure route do', () => {
        // contact_consents.conversation_id is SET NULL on delete ("must not ... delete the evidence"), and the erasure route never touches the table.
        assert.match(read('src/config/migration_v50_whatsapp.sql'), /conversation_id UUID REFERENCES conversations\(id\) ON DELETE SET NULL/);
        assert.equal(read('src/services/erasure.ts').includes('contact_consents'), false, 'if erasure starts deleting the stop record, change section 4 and /data-deletion section 2');
        const en = words(retentionSection.en);
        assert.ok(en.includes('WhatsApp — a request to stop: if you asked to stop the messages (section 1), the record of it — your Meta user ID, the words you wrote and when — is kept with no automatic expiry, and is not deleted when your conversation is, so that your request keeps being honoured.'));
        const ar = words(retentionSection.ar);
        assert.ok(ar.includes('واتساب — طلب إيقاف الرسائل: إن طلبتَ إيقاف الرسائل (القسم 1)، يبقى سجلّ ذلك — معرّفك عند ميتا والكلمات التي كتبتَها ووقتها — بلا مدة انتهاء تلقائية، ولا يُحذف حين تُحذف محادثتك، كي يظلّ طلبك نافذاً.'));
    });
});

describe('/data-deletion — WhatsApp: how to ask, what is deleted, what deletion cannot reach (FR-018, FR-029)', () => {
    const slice = (lang: 'ar' | 'en', from: string, to: string): string => between(deletion[lang], from, to);
    const s1 = { ar: slice('ar', '<h2>1. ما هو المخزَّن عنك</h2>', '<h2>2. '), en: slice('en', '<h2>1. What is stored about you</h2>', '<h2>2. ') };
    const s2 = { ar: slice('ar', '<h2>2. كيف تطلب الحذف</h2>', '<h2>3. '), en: slice('en', '<h2>2. How to request deletion</h2>', '<h2>3. ') };
    const s3 = { ar: slice('ar', '<h2>3. ما يُحذف دون أن تطلب</h2>', '<h2>4. '), en: slice('en', '<h2>3. What is deleted without asking</h2>', '<h2>4. ') };
    const s4 = { ar: slice('ar', '<h2>4. ما يبقى إلى أن تطلب حذفه</h2>', '<h2>5. '), en: slice('en', '<h2>4. What stays until you ask</h2>', '<h2>5. ') };
    const s5 = { ar: slice('ar', '<h2>5. ما لا يستطيع الحذف الوصول إليه</h2>', '<h2>6. '), en: slice('en', '<h2>5. What deletion cannot reach</h2>', '<h2>6. ') };

    it('opens by addressing someone who sent a WhatsApp message', () => {
        assert.ok(words(deletion.en).includes('If you commented on a post, or sent a direct message or a WhatsApp message, to an account or number running AutoReply Pro'));
        assert.ok(words(deletion.ar).includes('أو أرسلت رسالة خاصة أو رسالة على واتساب، إلى حساب أو رقم يستخدم'));
    });

    it('lists what is stored about a WhatsApp contact, and that less may be stored, never more', () => {
        const en = words(s1.en);
        assert.ok(en.includes('If you sent a message on WhatsApp: the text of your messages as you wrote them and of the replies sent to you, your name on your WhatsApp profile, your phone number if it reached us'));
        assert.ok(en.includes('your Meta user IDs and your WhatsApp username if you have one'));
        assert.ok(en.includes('the verbatim event received from Meta — a second copy of all of that — whatever was kept of your voice notes, photos and files, and, if you asked to stop the messages, a record of that request. Less than this may be stored, never more.'));
        const ar = words(s1.ar);
        assert.ok(ar.includes('إن أرسلتَ رسالة على واتساب: نصّ رسائلك كما كتبتها ونصّ الردود التي أُرسلت إليك، واسمك في ملفك على واتساب، ورقم هاتفك إن وصل إلينا'));
        assert.ok(ar.includes('ومعرّفاتك عند ميتا واسم المستخدم على واتساب إن وُجد'));
        assert.ok(ar.includes('وما حُفظ من مقاطعك الصوتية وصورك وملفاتك، وسجلّ طلبك إيقاف الرسائل إن طلبتَ ذلك. وقد يكون المخزَّن أقلّ من ذلك، ولا يكون أكثر.'));
    });

    it('says how a WhatsApp user asks: by email or by writing to the same number, with the phone number or username, looked up by hand', () => {
        const en = words(s2.en);
        assert.ok(en.includes('reply to the same account that messaged you on Instagram or Facebook (or to the same WhatsApp number) and ask for your data to be deleted'));
        assert.ok(en.includes('On WhatsApp, give the phone number you wrote from, or your WhatsApp username if you have one; the person handling the request looks your conversation up from it by hand.'));
        const ar = words(s2.ar);
        assert.ok(ar.includes('الذي راسلك على إنستجرام أو فيسبوك (أو على رقم واتساب الذي راسلته)'));
        assert.ok(ar.includes('وعلى واتساب اذكر رقم هاتفك الذي راسلتَ منه، أو اسم المستخدم على واتساب إن كان لك؛ فنبحث بهما يدوياً عن محادثتك.'));
        assert.ok(en.includes('the request is carried out by hand against the database'), 'the manual process is still the one described');
    });

    it('says what is deleted with the WhatsApp conversation, private files included, and when the file leaves storage', () => {
        const en = words(s2.en);
        assert.ok(en.includes('When your WhatsApp conversation is deleted, these go with it: all its messages with their text and the verbatim event received from Meta'));
        assert.ok(en.includes('what was stored about you in it (your WhatsApp name, your phone number, your ID, your username, how the conversation began)'));
        assert.ok(en.includes('and whatever was kept of your files — voice notes, photos and the rest — with the file itself removed from storage at the next daily clean-up.'));
        const ar = words(s2.ar);
        assert.ok(ar.includes('وحين تُحذف محادثتك على واتساب يُحذف معها: كل رسائلها بنصّها وحدثها الأصلي كما ورد من ميتا'));
        assert.ok(ar.includes('(اسمك على واتساب، ورقم هاتفك، ومعرّفك، واسم المستخدم، وكيف بدأت المحادثة)'));
        assert.ok(ar.includes('وما حُفظ من ملفاتك — مقاطع صوتية وصور وغيرها — ويُزال الملف نفسه من مساحة التخزين في التنظيف اليومي التالي.'));
    });

    it('says the one thing a WhatsApp deletion keeps: the record of a request to stop', () => {
        assert.ok(words(s2.en).includes('What is not deleted is the record of your request to stop the messages, if you made one (your Meta user ID, the words you wrote and when): it is kept so that your request keeps being honoured.'));
        assert.ok(words(s2.ar).includes('ولا يُحذف سجلّ طلبك إيقاف الرسائل، إن طلبتَ ذلك (معرّفك عند ميتا والكلمات التي كتبتَها ووقتها): يبقى كي يظلّ طلبك نافذاً.'));
    });

    it('says what is deleted without asking (an unreferenced file after the code\'s number of days) and what stays until asked', () => {
        assert.ok(words(s3.en).includes(`A file sent on WhatsApp, if a copy of it was kept and no message points to it, is deleted ${PRIVATE_MEDIA_ORPHAN_DAYS} days after it was saved.`));
        assert.ok(words(s3.ar).includes(`يُحذف بعد ${PRIVATE_MEDIA_ORPHAN_DAYS} يوماً من حفظه`));
        assert.ok(words(s4.en).includes('That holds on WhatsApp too: the text of your messages, your WhatsApp name and phone number, and whatever was kept of your files with the conversation.'));
        assert.ok(words(s4.ar).includes('وهذا يسري على واتساب كذلك: نصّ رسائلك واسمك على واتساب ورقم هاتفك وما حُفظ من ملفاتك مع المحادثة.'));
    });

    it('says what deletion cannot reach: Meta\'s WhatsApp copy, the AI providers\' copies (never Google), and the alerts at Resend and Telegram', () => {
        const en = words(s5.en);
        assert.ok(en.includes('Meta (WhatsApp): your messages already exist in the WhatsApp app on your phone; that copy is yours.'));
        assert.ok(en.includes("Meta's documentation says it keeps a message for at most 30 days; that copy is Meta's, and we neither own nor control it."));
        assert.ok(en.includes('AI providers — WhatsApp: if the assistant answered your WhatsApp messages, the text of your message and up to the last twelve messages of your conversation reached Groq, Anthropic or OpenAI so that it could write the reply, and did not reach Google.'));
        assert.ok(en.includes('If you sent a voice note, it may have reached Groq to be turned into text.'));
        const ar = words(s5.ar);
        assert.ok(ar.includes('ميتا (واتساب): رسائلك موجودة أصلاً في تطبيق واتساب لديك، وتلك نسختك.'));
        assert.ok(ar.includes('يُحتفَظ بها لديها مدة أقصاها 30 يوماً'));
        assert.ok(ar.includes('مزوّدو الذكاء الاصطناعي — واتساب: إن ردّ المساعد على رسائلك على واتساب، فقد وصل نصّ رسالتك وما يصل إلى آخر اثنتي عشرة رسالة من محادثتك إلى Groq أو Anthropic أو OpenAI ليكتب الردّ، ولم يصل إلى جوجل.'));
        assert.ok(ar.includes('فقد يكون وصل إلى Groq ليُحوَّل إلى نصّ'));
    });

    it('keeps the new bullets between Google\'s and the logs', () => {
        for (const lang of ['ar', 'en'] as const) {
            const doc = s5[lang];
            const google = doc.indexOf(lang === 'ar' ? '<strong>جوجل:</strong>' : '<strong>Google:</strong>');
            const wa = doc.indexOf(lang === 'ar' ? '<strong>مزوّدو الذكاء الاصطناعي — واتساب:</strong>' : '<strong>AI providers — WhatsApp:</strong>');
            const alerts = doc.indexOf(lang === 'ar' ? '<strong>تنبيهات المُشغّل:</strong>' : '<strong>Alerts to the operator:</strong>');
            const logs = doc.indexOf(lang === 'ar' ? '<strong>سجلّات التشغيل:</strong>' : '<strong>Operational logs:</strong>');
            assert.ok(google > 0 && google < wa && wa < alerts && alerts < logs, lang);
        }
    });
});

describe('/terms — WhatsApp: Meta\'s terms apply, the assistant is automated, a person is available on request (FR-012, FR-015)', () => {
    const slice = (lang: 'ar' | 'en', from: string, to: string): string => between(terms[lang], from, to);
    const service = { ar: slice('ar', '<h2 id="service-ar">', '<h2 id="connecting-ar">'), en: slice('en', '<h2 id="service-en">', '<h2 id="connecting-en">') };
    const connecting = { ar: slice('ar', '<h2 id="connecting-ar">', '<h2 id="responsibilities-ar">'), en: slice('en', '<h2 id="connecting-en">', '<h2 id="responsibilities-en">') };
    const duties = { ar: slice('ar', '<h2 id="responsibilities-ar">', '<h2 id="acceptable-use-ar">'), en: slice('en', '<h2 id="responsibilities-en">', '<h2 id="acceptable-use-en">') };
    const platforms = { ar: slice('ar', '<h2 id="platforms-ar">', '<h2 id="disconnecting-ar">'), en: slice('en', '<h2 id="platforms-en">', '<h2 id="disconnecting-en">') };
    const disconnecting = { ar: slice('ar', '<h2 id="disconnecting-ar">', '<h2 id="data-ar">'), en: slice('en', '<h2 id="disconnecting-en">', '<h2 id="data-en">') };

    it('names WhatsApp at the top, with the same stamp in both languages', () => {
        assert.ok(words(terms.en).includes('and to your WhatsApp Business number'));
        assert.ok(words(terms.en).includes('connects to your Instagram, Facebook, WhatsApp and TikTok accounts'));
        assert.ok(words(terms.ar).includes('وبرقمك على واتساب للأعمال'));
        assert.ok(terms.ar.includes('datetime="2026-10-25"') && terms.en.includes('datetime="2026-10-25"'));
    });

    it('says what the service does on WhatsApp: it answers on the owner\'s behalf, written by an AI model, announced as automated, a person on request, «إيقاف» / "stop" ends it', () => {
        const en = words(service.en);
        assert.ok(en.includes("WhatsApp: if you connect a WhatsApp Business number through Meta's WhatsApp Cloud API, the assistant answers the messages that arrive at that number on your behalf."));
        assert.ok(en.includes('The replies are written by AI models, not a person, at providers whose terms say they do not train their models on what is sent to them'));
        assert.ok(en.includes('the first reply to anyone says it is automated'));
        assert.ok(en.includes('If the person asks for a human, the assistant is built to stop replying and hand the conversation to you, to answer yourself'));
        assert.ok(en.includes('if they write «إيقاف» or “stop”, it stops and sends no follow-ups.'));
        const ar = words(service.ar);
        assert.ok(ar.includes('واتساب: إن ربطتَ رقماً على واتساب للأعمال عبر WhatsApp Cloud API من ميتا، يردّ المساعد على الرسائل الواردة إلى ذلك الرقم نيابةً عنك.'));
        assert.ok(ar.includes('تكتب الردودَ نماذجُ ذكاء اصطناعي لا إنسان، لدى مزوّدين تنصّ شروطهم على ألّا يدرّبوا نماذجهم على ما يُرسَل إليهم'));
        assert.ok(ar.includes('وأول ردّ يصل إلى أي شخص يقول إنه ردّ آلي.'));
        assert.ok(ar.includes('وإن طلب الشخص التحدّث إلى إنسان فالمساعد مصمَّم على أن يتوقّف عن الردّ وتُحوَّل المحادثة إليك لتردّ بنفسك'));
        assert.ok(ar.includes('وإن كتب «إيقاف» أو stop فيتوقّف ولا يرسل له متابعات.'));
    });

    it('says WhatsApp is connected with a token Meta issues, never a password', () => {
        assert.ok(words(connecting.en).includes('WhatsApp with an access token Meta issues for your WhatsApp Business account and number'));
        assert.ok(words(connecting.en).includes('In every case, we never ask for or store your account password.'));
        assert.ok(words(connecting.ar).includes('ويُربَط واتساب برمز وصول تُصدره ميتا لحسابك على واتساب للأعمال ورقمه. في كل الحالات لا نطلب كلمة مرور حسابك ولا نخزّنها.'));
    });

    it('says the use of WhatsApp is subject to Meta\'s WhatsApp Business terms and policy, linked, and that the owner answers a handed-over conversation', () => {
        for (const lang of ['ar', 'en'] as const) {
            const marker = `<li id="whatsapp-${lang}">`;
            const at = duties[lang].indexOf(marker);
            assert.ok(at >= 0, lang);
            const item = duties[lang].slice(at, duties[lang].indexOf('</li>', at));
            const hrefs = [...item.matchAll(/<a\b([^>]*)>/g)].map((m) => /href="([^"]+)"/.exec(m[1]!)?.[1]);
            assert.deepEqual(hrefs, [
                'https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform',
                'https://www.whatsapp.com/legal/WhatsApp-Terms-for-WhatsApp-Business-Platform',
                'https://business.whatsapp.com/policy',
            ], lang);
            for (const attrs of [...item.matchAll(/<a\b([^>]*)>/g)].map((m) => m[1]!)) assert.match(attrs, /target="_blank" rel="noopener noreferrer"/, lang);
        }
        const en = words(duties.en);
        assert.ok(en.includes("your use of WhatsApp through the service is subject to Meta's Terms for the WhatsApp Business Platform, WhatsApp's Terms for the WhatsApp Business Platform and the WhatsApp Business Messaging Policy"));
        assert.ok(en.includes('And you are responsible for answering a conversation yourself once the assistant hands it over to you.'));
        const ar = words(duties.ar);
        assert.ok(ar.includes('يسري على استخدامك لواتساب عبر الخدمة شروط ميتا لمنصّة واتساب للأعمال وشروط واتساب لمنصّة واتساب للأعمال وسياسة واتساب للمراسلة التجارية'));
        assert.ok(ar.includes('وأنت مسؤول عن الردّ على المحادثة بنفسك حين يحوّلها المساعد إليك.'));
    });

    it('adds WhatsApp to the trademarks and to how to disconnect it', () => {
        assert.ok(words(platforms.en).includes('Instagram, Facebook, WhatsApp, TikTok and YouTube are trademarks of their respective owners.'));
        assert.ok(words(platforms.ar).includes('إنستجرام وفيسبوك وواتساب وتيك توك ويوتيوب علامات تجارية مملوكة لأصحابها.'));
        assert.ok(words(disconnecting.en).includes('WhatsApp: disconnect it from Settings in the dashboard, which unsubscribes the app from your WhatsApp Business account at Meta (if Meta still accepts the token), deletes the stored token and switches the assistant off; or revoke the token at Meta, after which it stops working.'));
        assert.ok(words(disconnecting.ar).includes('واتساب: افصله من الإعدادات في لوحة التحكم، فيُلغي التطبيق اشتراكه في حسابك على واتساب للأعمال لدى ميتا (إن كانت ميتا لا تزال تقبل الرمز) ويمحو الرمز المخزَّن ويوقف المساعد؛ أو ألغِ الرمز لدى ميتا، فيتوقّف عن العمل.'));
    });
});
