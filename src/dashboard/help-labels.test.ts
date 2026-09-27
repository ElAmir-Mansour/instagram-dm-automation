/**
 * H4: the Help Center names buttons and fields exactly as the interface shows them.
 *
 * help-content.js promises it — "Button and field names are written exactly as the interface
 * shows them … When a label changes in i18n.js, change it here too" — and nothing checked it.
 * By 2026-09-27 the Arabic buttons had moved to the imperative («احفظ الإعدادات», «افحص
 * المكتبة», «أنشئ عاملاً») while 30-odd article labels still said «حفظ الإعدادات», «فحص
 * المكتبة», «إنشاء عامل»: a reader told to press a button that does not exist by that name.
 *
 * The rule, per language: every `**bold**` in an article body is an interface string of that
 * language. It matches when, after trimming and dropping trailing punctuation from both sides,
 * it equals an i18n value, or the static text a value starts with before its first
 * `{placeholder}` («آخر ظهور {when}» is shown as «آخر ظهور …»).
 *
 * Bold that is NOT a label — a feature name leading a list item, a rule stated for emphasis, a
 * control in Meta's or TikTok's own apps, a program name — is listed below with its reason.
 * SHORTENED is for a label the article quotes the start of («كرّر» for the icon button whose
 * name is «كرّر الشريحة {n}»); the test checks the interface string still starts that way.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

type Json = Record<string, any>;
type Lang = 'ar' | 'en';

const ctx: Json = {};
ctx.globalThis = ctx;
vm.createContext(ctx);
const STRINGS = vm.runInContext(`${readFileSync('dashboard/js/i18n.js', 'utf8')}\n;I18N.strings`, ctx, { filename: 'i18n.js' }) as Record<Lang, Record<string, string>>;
const CONTENT = vm.runInContext(`${readFileSync('dashboard/js/help-content.js', 'utf8')}\n;HelpContent`, ctx, { filename: 'help-content.js' }) as Json;

/** Deliberate non-UI emphasis, per language: the bold text (as `clean` leaves it) → why. */
const NOT_UI: Record<Lang, Record<string, string>> = {
    ar: {
        'ردود الكلمات المفتاحية': 'feature name leading a list item',
        'وكيل ذكي للرسائل': 'feature name leading a list item',
        'استوديو الكاروسيل': 'feature name leading a list item',
        'احترافي': 'emphasis: the Instagram account type',
        'رمز وصول للصفحة': 'a Meta concept, not a control',
        'الوصول للبيانات': 'a Meta concept, not a control',
        'من 2 إلى 10 صور': 'carousel rule stated for emphasis',
        'JPEG فقط': 'carousel rule stated for emphasis',
        'الصورة الأولى تحدد القصّ': 'carousel rule stated for emphasis',
        'الترتيب هنا هو ترتيب الشرائح': 'carousel rule stated for emphasis',
        'مع كل الأذونات اللي عندك الآن': 'in Meta’s Graph API Explorer, not this interface',
        'منشوراتك أنت': 'emphasis',
        'سنة وحدة': 'emphasis',
        'النشر المباشر ينزل بخصوصية «أنا فقط»': 'TikTok rule stated for emphasis',
        'حسابك لازم يكون خاصاً وقت النشر': 'TikTok rule stated for emphasis',
        '⋯': 'a control in the TikTok app',
        'الخصوصية': 'a control in the TikTok app, and the lead of a privacy note',
        'عامة تلقائياً': 'emphasis',
        'الموقع الإلكتروني': 'a field in the TikTok app',
        'تعديل الملف الشخصي': 'a control in the TikTok app',
        'ماك': 'emphasis: the platform the worker runs on',
        'فيديوهاتك كبيرة': 'reason leading a list item',
        'الرسم يحتاج جهازاً': 'reason leading a list item',
        'خصوصيتك': 'reason leading a list item',
        'يقدر': 'list heading',
        'ما يقدر': 'list heading',
        'يتصل للخارج بس': 'security property leading a list item',
        'رمز خاص لكل عامل': 'security property leading a list item',
        'تلغيه بضغطة': 'security property leading a list item',
        'بس نسخ صغيرة تروح لـ Google': 'security property leading a list item',
        'Node 22': 'a program the worker needs',
        'ffmpeg': 'a program the worker needs',
        'لقطة': 'emphasis',
        'خاصاً': 'emphasis: the TikTok account setting',
        'Gemini': 'a product name',
        'المفتاح المجاني حدوده ضيقة': 'quota fact leading a list item',
    },
    en: {
        'Keyword replies': 'feature name leading a list item',
        'An AI agent for DMs': 'feature name leading a list item',
        'Post scheduling': 'feature name leading a list item',
        'Carousel Studio': 'feature name leading a list item',
        'professional': 'emphasis: the Instagram account type',
        'Page Access Token': 'a Meta concept, not a control',
        'data access': 'a Meta concept, not a control',
        '2 to 10 images': 'carousel rule stated for emphasis',
        'JPEG only': 'carousel rule stated for emphasis',
        'The first image sets the crop': 'carousel rule stated for emphasis',
        'The order here is the order of the slides': 'carousel rule stated for emphasis',
        'together with every permission you have now': 'in Meta’s Graph API Explorer, not this interface',
        'your own posts': 'emphasis',
        'one year': 'emphasis',
        'Direct posts go up as “Only me”': 'TikTok rule stated for emphasis',
        'Your account must be private while posting': 'TikTok rule stated for emphasis',
        '⋯': 'a control in the TikTok app',
        'Privacy': 'a control in the TikTok app, and the lead of a privacy note',
        'public automatically': 'emphasis',
        'Website': 'a field in the TikTok app',
        'Edit profile': 'a control in the TikTok app',
        'Mac': 'emphasis: the platform the worker runs on',
        'Your videos are big': 'reason leading a list item',
        'Drawing needs a real computer': 'reason leading a list item',
        'Your privacy': 'reason leading a list item',
        'It can': 'list heading',
        'It can’t': 'list heading',
        'Outbound only': 'security property leading a list item',
        'A token per worker, per account': 'security property leading a list item',
        'Revocable in one click': 'security property leading a list item',
        'Only small, low-resolution previews go to Google': 'security property leading a list item',
        'Node 22': 'a program the worker needs',
        'ffmpeg': 'a program the worker needs',
        'moments': 'emphasis',
        'private': 'emphasis: the TikTok account setting',
        'Gemini': 'a product name',
        'A free key has tight limits': 'quota fact leading a list item',
    },
};

/** A label the article quotes the START of → the key whose value it starts. */
const SHORTENED: Record<Lang, Record<string, string>> = {
    ar: {
        'كرّر': 'studio.slides.duplicateN',              // the icon button «كرّر الشريحة {n}»
        'سطر إنستجرام': 'studio.settings.previewIg',      // «سطر إنستجرام، بالكلمة «…»»
        'لم يُحدَّد مجلد المكتبة': 'studio.library.noFolder',
        'تعديلات غير محفوظة': 'studio.editor.unsaved',    // «تعديلات غير محفوظة · تتحدّث المعاينة …»
    },
    en: {
        'Duplicate': 'studio.slides.duplicateN',
        'Instagram line': 'studio.settings.previewIg',
        'No library folder is set': 'studio.library.noFolder',
    },
};

const TRAILING = /[\s:：.،,؛;!?؟…]+$/u;
/** Trimmed, without trailing punctuation: `**Label:**` and «Label.» compare as «Label». */
const clean = (s: string): string => s.trim().replace(TRAILING, '').trim();

/** Every form an interface string can be quoted in, for one language. */
function labelsOf(lang: Lang): Set<string> {
    const out = new Set<string>();
    for (const value of Object.values(STRINGS[lang])) {
        const s = String(value);
        out.add(s.trim());
        out.add(clean(s));
        const at = s.indexOf('{');
        if (at > 0) {
            const head = s.slice(0, at).replace(/[\s:：.،,؛;!?؟…(«“"'—-]+$/u, '').trim();
            if (head) out.add(head);
        }
    }
    return out;
}

interface Bold { text: string; where: string }

/** Every `**…**` in the article bodies of one language, with the section it is in. */
function boldsOf(lang: Lang): Bold[] {
    const out: Bold[] = [];
    const walk = (value: unknown, where: string): void => {
        if (typeof value === 'string') {
            for (const m of value.matchAll(/\*\*(.+?)\*\*/g)) out.push({ text: m[1]!, where });
        } else if (Array.isArray(value)) {
            for (const v of value) walk(v, where);
        } else if (value && typeof value === 'object') {
            for (const v of Object.values(value)) walk(v, where);
        }
    };
    for (const article of CONTENT.articles as Json[]) {
        for (const section of article.sections as Json[]) walk(section.body[lang], `${article.slug}#${section.id}`);
    }
    return out;
}

describe('Help Center — bold labels match the interface (H4)', () => {
    for (const lang of ['ar', 'en'] as const) {
        it(`every **label** in the ${lang} articles is a ${lang} interface string, or is listed as not one`, () => {
            const labels = labelsOf(lang);
            const bolds = boldsOf(lang);
            const matched = bolds.filter((b) => labels.has(b.text.trim()) || labels.has(clean(b.text)));
            // A scan that silently finds nothing would pass, so it has to find the real labels.
            assert.ok(bolds.length > 300, `${bolds.length} bold spans in ${lang}`);
            assert.ok(matched.length > 250, `${matched.length} of them match an interface string`);

            const drift = bolds
                .filter((b) => !matched.includes(b))
                .filter((b) => !Object.hasOwn(NOT_UI[lang], clean(b.text)) && !Object.hasOwn(SHORTENED[lang], clean(b.text)))
                .map((b) => `${b.where}: «${b.text}»`);
            assert.deepEqual(drift, [],
                `${drift.length} label(s) in the ${lang} Help Center match no ${lang} interface string. `
                + 'Change the text inside **…** to what the screen shows now, or — if it is not a label — add it to NOT_UI with a reason.');
        });

        it(`the ${lang} allow-lists are still needed, and every shortened label still starts its string`, () => {
            const labels = labelsOf(lang);
            const used = new Set(boldsOf(lang).map((b) => clean(b.text)));
            for (const text of Object.keys(NOT_UI[lang])) {
                assert.ok(used.has(text), `NOT_UI.${lang} «${text}» no longer appears in any article — remove it`);
                assert.equal(labels.has(text), false, `NOT_UI.${lang} «${text}» is an interface string now — remove it from the list`);
            }
            for (const [text, key] of Object.entries(SHORTENED[lang])) {
                assert.ok(used.has(text), `SHORTENED.${lang} «${text}» no longer appears in any article — remove it`);
                const value = STRINGS[lang][key];
                assert.ok(value !== undefined, `SHORTENED.${lang} «${text}» points at ${key}, which is gone`);
                assert.ok(value.startsWith(text), `«${text}» no longer starts ${key} («${value}») — the label changed; update the article`);
            }
        });
    }
});
