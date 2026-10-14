/**
 * The AI providers named as sub-processors on /privacy and /data-deletion (P20d), in both languages.
 *
 * Meta, TikTok and Google reviewers and the account owners themselves read these pages, so each sentence is a claim about the product.
 * The AI providers layer is planned, not live (DESIGN.md §9's truth table), so what is pinned is the shape of an honest disclosure:
 *
 *   - the five names (Anthropic, OpenAI, Google (Gemini), OpenRouter, and an address the operator enters), in both languages, in the same order;
 *   - that they are used ONLY when the operator has added a key and left the provider on, which is the whole difference between "we use
 *     these" and "these are possible";
 *   - what goes to them (the account owner's profile and content, for drafting), and what does not (anything about people who comment or
 *     message), with the one exception that already exists named, not hidden: the DM text Google receives (section 3);
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

    it('lists the same five, in the same order, in Arabic and English', () => {
        const names = (html: string) => [...html.matchAll(/<li>\s*<strong>([\s\S]*?)<\/strong>/g)].map((m) => words(m[1]!).trim());
        const ar = names(block.ar);
        const en = names(block.en);
        assert.equal(ar.length, 5);
        assert.equal(en.length, 5);
        assert.deepEqual(en, ['Anthropic', 'OpenAI', 'Google', 'OpenRouter', 'A service at an address the operator enters']);
        assert.deepEqual(ar.slice(0, 4), ['Anthropic', 'OpenAI', 'جوجل', 'OpenRouter']);
        assert.equal(ar[4], 'خدمة بعنوان يحدّده المُشغّل');
        assert.ok(words(block.ar).includes('Gemini') && words(block.en).includes('Gemini'));
        assert.ok(words(block.en).includes('OpenAI-compatible'));
    });

    it('says they are used only when the operator has added a key and left the provider on, and that until then nothing reaches them', () => {
        assert.ok(words(block.en).includes('None of them is used unless the operator has added its key and left it switched on; until then nothing reaches it.'));
        assert.ok(words(block.ar).includes('لا يُستخدم أيٌّ منهم إلا إن أضاف المُشغّل مفتاحه وأبقاه مفعّلاً، وما لم يفعل ذلك لا يصله شيء.'));
    });

    it('says what is sent (the account owner\'s profile and content, to write a draft) and what is not (anything about people who comment or message)', () => {
        assert.ok(words(block.en).includes('the account owner\'s profile and content'));
        assert.ok(words(block.en).includes('so that a draft can be written for them'));
        assert.ok(words(block.en).includes('Nothing about people who comment or message on Instagram or Facebook is sent through this route'));
        assert.ok(words(block.ar).includes('ملف صاحب الحساب ومحتواه'));
        assert.ok(words(block.ar).includes('لا يُرسَل عبر هذا المسار شيء عمّن يعلّق أو يراسل على إنستجرام أو فيسبوك'));
    });

    it('does not hide the one thing that already reaches Google (direct-message text): it points to section 3 rather than denying it', () => {
        assert.ok(words(block.en).includes('the direct-message text that reaches Google is described in section 3'));
        assert.ok(words(block.ar).includes('أما نصوص الرسائل الخاصة التي تصل إلى جوجل فموضّحة في القسم 3'));
        assert.ok(privacy.en.includes('id="gemini-en"') && privacy.ar.includes('id="gemini-ar"'), 'and section 3 is there');
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
        assert.ok(privacy.ar.includes('آخر تحديث: 14 أكتوبر 2026') && privacy.en.includes('Last updated: 14 October 2026'));
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

    it('names the four providers and the operator\'s own address, scopes it to account owners, and says the copy is theirs', () => {
        const en = words(section5.en);
        for (const name of ['Anthropic', 'OpenAI', 'Google (Gemini)', 'OpenRouter', 'a service at an address the operator added']) assert.ok(en.includes(name), name);
        assert.ok(en.includes('if you are an account owner and the operator of the tool has switched on a provider'));
        assert.ok(en.includes('we cannot delete it on your behalf'));
        assert.ok(en.includes('Nothing about people who comment or message on Instagram or Facebook is sent to them'));
        const ar = words(section5.ar);
        for (const name of ['Anthropic', 'OpenAI', 'Gemini', 'OpenRouter']) assert.ok(ar.includes(name), name);
        assert.ok(ar.includes('إن كنتَ صاحب حساب وفعّل مُشغّل الأداة مزوّداً'));
        assert.ok(ar.includes('ولا نستطيع حذفها نيابةً عنك'));
        assert.ok(ar.includes('لا يصلهم شيء عمّن يعلّق أو يراسل على إنستجرام أو فيسبوك'));
    });

    it('points to the list on /privacy, by section, in both languages', () => {
        for (const lang of ['ar', 'en'] as const) {
            const doc = section5[lang];
            const bullet = doc.slice(doc.indexOf(lang === 'ar' ? 'مزوّدو الذكاء الاصطناعي' : 'AI providers:'));
            assert.match(bullet, /القسم 5 من <a href="\/privacy">سياسة الخصوصية<\/a>|section 5 of the <a href="\/privacy">privacy policy<\/a>/, lang);
        }
    });

    it('carries the same date in both languages', () => {
        assert.ok(deletion.ar.includes('آخر تحديث: 14 أكتوبر 2026') && deletion.en.includes('Last updated: 14 October 2026'));
    });
});

describe('both pages — no provider is promised as live', () => {
    for (const p of ['privacy', 'data-deletion']) {
        it(`${p}: nothing says "we use Anthropic"; it says what happens if the operator switches one on`, () => {
            const html = noComments(read(`public/${p}.html`));
            // The layer is planned, not live: the owner rules on these pages (no invented claims) are checked by landingTruth's, and this is
            // the one that is new, that no sentence states a provider as in use.
            assert.equal(/we (?:use|send to|rely on) (?:Anthropic|OpenAI|OpenRouter)/i.test(words(html)), false);
        });
    }
});
