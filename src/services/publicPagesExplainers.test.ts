/**
 * What /privacy says about illustrated explainers (spec 003-illustrated-explainers, T069), in both languages.
 *
 * Reviewers and account owners read this page, so each sentence is a claim about the product. Pinned here: the explainers part of
 * section 1 exists in both languages and says the feature uses only the platform owner's own material; Google's line in section 5 names
 * what it receives for explainers; Cloudflare is named as a processor with its own policy, in the services list and not among the
 * operator's AI providers (publicPagesSubprocessors.test.ts pins those six); and section 4 says how long the files are kept.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const clean = readFileSync('public/privacy.html', 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const doc = {
    ar: clean.slice(clean.indexOf('<article class="doc" data-doc-lang="ar"'), clean.indexOf('<article class="doc" data-doc-lang="en"')),
    en: clean.slice(clean.indexOf('<article class="doc" data-doc-lang="en"'), clean.indexOf('</main>')),
};
const words = (html: string) => html.replace(/<\/?(?:bdi|a|span|strong|em|b)\b[^>]*>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
function part(lang: 'ar' | 'en', from: string, to: string): string {
    const d = doc[lang];
    const a = d.indexOf(from);
    const b = d.indexOf(to, a);
    assert.ok(a >= 0 && b > a, `${lang}: ${from} … ${to}`);
    return d.slice(a, b);
}

describe('/privacy — illustrated explainers', () => {
    it('has its own part of section 1, before section 2, in both languages', () => {
        for (const lang of ['ar', 'en'] as const) {
            const d = doc[lang];
            const collected = d.indexOf(`<h2 id="collected-${lang}">`);
            const at = d.indexOf(`<h3 id="explainers-${lang}">`);
            assert.ok(collected > 0 && collected < at && at < d.indexOf(`<h2 id="purposes-${lang}">`), lang);
        }
    });

    it("says it uses only the owner's own material, and names where the script, the voice and the pictures go", () => {
        const en = words(part('en', '<h3 id="explainers-en">', '<h2 id="purposes-en">'));
        assert.match(en, /They use only the owner's own material: no comment, message, contact or form answer/);
        for (const name of ['Claude', 'Anthropic', 'Gemini', 'Google Search', 'Cloudflare Workers AI']) assert.ok(en.includes(name), name);
        assert.match(en, /the reference pictures the owner chose for their recurring cartoon characters are sent to Cloudflare Workers AI/);
        assert.doesNotMatch(en, /No photo of a real person/, 'the owner may upload any picture as a reference: the page does not promise what the code does not hold');
        const ar = words(part('ar', '<h3 id="explainers-ar">', '<h2 id="purposes-ar">'));
        assert.match(ar, /ولا تُستخدم فيها إلا مواد صاحب المنصة نفسه/);
        for (const name of ['Claude', 'Anthropic', 'Gemini', 'Cloudflare Workers AI']) assert.ok(ar.includes(name), name);
        assert.match(ar, /والصور المرجعية التي اختارها صاحب المنصة لشخصياته الكرتونية المتكررة/);
        assert.doesNotMatch(ar, /صورة فوتوغرافية لشخص حقيقي/);
    });

    it("names Cloudflare among the services of section 5, with its policy, and grows Google's line, not the AI providers' six", () => {
        for (const lang of ['ar', 'en'] as const) {
            const services = part(lang, `<h2 id="processors-${lang}">`, `<h3 id="ai-providers-${lang}">`);
            assert.ok(services.includes('https://www.cloudflare.com/privacypolicy/'), lang);
            assert.ok(words(services).includes('Workers AI'), lang);
            const providers = part(lang, `<h3 id="ai-providers-${lang}">`, `<h2 id="deletion-${lang}">`);
            assert.ok(!providers.includes('Cloudflare'), `${lang}: Cloudflare draws pictures with the owner's own account, it is not an AI provider an operator switches on`);
        }
        assert.match(words(part('en', '<h2 id="processors-en">', '<h3 id="ai-providers-en">')), /For the platform owner's illustrated explainers it also receives the script to read aloud/);
        assert.match(words(part('ar', '<h2 id="processors-ar">', '<h3 id="ai-providers-ar">')), /وفي فيديوهات الشرح المصوّرة لصاحب المنصة تتلقّى أيضاً النص/);
    });

    it('says in section 4 how long the files are kept', () => {
        assert.match(words(part('en', '<h2 id="retention-en">', '<h2 id="processors-en">')), /Illustrated explainers — .*until 30 days after the explainer's last scheduled post/);
        assert.match(words(part('ar', '<h2 id="retention-ar">', '<h2 id="processors-ar">')), /فيديوهات الشرح المصوّرة — .*حتى 30 يوماً بعد آخر منشور مجدول/);
    });
});
