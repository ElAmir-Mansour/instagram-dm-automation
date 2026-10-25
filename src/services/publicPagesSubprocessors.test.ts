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
 *   - that the contents list still has one link per section (a sub-processor list is an h3, not a new section), and the stamps agree.
 *
 * The pages' bodies are otherwise untouched by this change, so the existing checks on them (publicPagesFiles, publicPagesChrome,
 * landingTruth's owner rules) are what say the rest is still true.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

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
        assert.ok(en.includes('Your username, your account ID and the conversation ID are not sent to it either.'));
        assert.ok(en.includes('If that provider cannot answer, the reply may be written by Gemini as described above.'));
        const ar = words(between(privacy.ar, '<h2 id="gemini-ar">', '<h2 id="retention-ar">'));
        assert.ok(ar.includes('يُرسَل افتراضياً نصّ رسالتك وآخر ثماني رسائل من المحادثة'));
        assert.ok(ar.includes('والحساب الذي يستخدم وضع المبيعات في الأداة تُكتب ردوده بهذه الطريقة دائماً'));
        assert.ok(ar.includes('نصّ رسالتك وما يصل إلى آخر اثنتي عشرة رسالة من المحادثة، مع اتجاه كل رسالة، إلى ذلك المزوّد بدلاً من جوجل'));
        assert.ok(ar.includes('(الكلمة نفسها، لا تعليقك)'));
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
        assert.ok(deletion.ar.includes('آخر تحديث: 15 أكتوبر 2026') && deletion.en.includes('Last updated: 15 October 2026'));
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
