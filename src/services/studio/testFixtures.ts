/**
 * Test fixtures for the Studio writer: two tenants' settings. Imported by tests only.
 *
 * `ELAMIR_SETTINGS` holds ElAmir's values exactly as his tenant's seed should (STUDIO.md §8, and
 * the examples in §10.2's comments). Production code never reads it: v1.1 forbids hardcoding a
 * tenant, so his values reach the writer only through his `studio_settings` row.
 * `ENGLISH_SETTINGS` is a neutral English tenant built on the defaults.
 */
import { DEFAULT_PALETTE, defaultStudioSettings, type StudioSettings } from './settingsTypes.js';

/** STUDIO.md §8, verbatim, with its two topical lines as the contract writes them. */
export const SECTION_8_DM = `هلا {username} 👋

<question line about the topic>

<one-sentence pitch naming the course section>

🎬 شوف الكورس كامل من هنا:
https://www.udemy.com/course/agentic-ai-arabic/?referralCode=02A626DDDA3FDAB6AB34

داخل الكورس:
✅ ٣٤ درس · ٥ ساعات و٤٠ دقيقة
✅ ١١ قسم — كل قسم تطبيق عملي من الصفر
✅ شهادة إتمام + وصول مدى الحياة
✅ ضمان استرجاع ٣٠ يوم من Udemy

عندك سؤال؟ رد على هالرسالة — أنا أرد بنفسي ✌️`;

const ELAMIR_VOICE = `Audience: Arabic speakers, mostly in the Gulf, curious about AI but not engineers.
- Light Gulf / white dialect: «شغّال»، «مو»، «وش»، «تبي»، «لين»، «بس»، «اللي»، «زي»، «هذي». No heavy fusha («سوف»، «لذلك»، «إنّ») and no Egyptian or Levantine («عايز»، «هيك»، «بدّك»).
- The result first, the tool second: «ملفاتك السرية… ما تطلع من جهازك» comes before «LM Studio».
- Short, punchy lines that read in two seconds.
- Product names stay in Latin script as the product writes them: NotebookLM, LM Studio, Google Opal.
- Hooks name a pain or a promise, often turning on «…»: «الدردشة ماتت… وبدأ عصر الوكيل».
- Never mention MCP.`;

export const ELAMIR_SETTINGS: StudioSettings = {
    brand: {
        name: 'Agentic AI بالعربي',
        signature: { latin: 'AGENTIC AI', local: 'بالعربي' },
        palette: [...DEFAULT_PALETTE],
        colors: { ink: '#08080A', paper: '#FAFAFA', muted: '#8A8A93' },
        fonts: { display: 'Cairo', mono: 'JetBrains Mono' },
        direction: 'rtl',
        theme: 'dark-grid',
    },
    voice: { language: 'ar', digits: 'arabic-indic', guide: ELAMIR_VOICE, avoid: ['MCP'] },
    product: {
        name: 'Agentic AI: الدليل العملي',
        url: 'https://www.udemy.com/course/agentic-ai-arabic/?referralCode=02A626DDDA3FDAB6AB34',
        facts: ['٣٤ درس', '٥ ساعات و٤٠ دقيقة', '١١ قسم', 'كل قسم تطبيق عملي من الصفر', 'شهادة إتمام', 'وصول مدى الحياة', 'ضمان استرجاع ٣٠ يوم من Udemy'],
        dmBullets: ['٣٤ درس · ٥ ساعات و٤٠ دقيقة', '١١ قسم — كل قسم تطبيق عملي من الصفر', 'شهادة إتمام + وصول مدى الحياة', 'ضمان استرجاع ٣٠ يوم من Udemy'],
    },
    cta: {
        instagramAsk: 'اكتب "{keyword}" بالتعليقات ويوصلك رابط الكورس بالخاص 📩',
        tiktokLine: '📚 الكورس كامل بالعربي — رابطه في البايو 🔗',
        dmTemplate: `هلا {username} 👋

{question}

{pitch}

🎬 شوف الكورس كامل من هنا:
{url}

داخل الكورس:
{bullets}

عندك سؤال؟ رد على هالرسالة — أنا أرد بنفسي ✌️`,
        slide: {
            igAsk: 'اكتب في التعليقات',
            igSub: 'ويوصلك الرابط بالخاص 📩',
            save: 'احفظ المنشور',
            ttHeadline: 'الكورس كامل بالعربي',
            ttPill: 'رابطه في البايو',
            ttSub: 'ادخل البروفايل واضغط الرابط 👆',
            follow: 'تابعني للمزيد',
            swipe: 'اسحب',
        },
    },
    schedule: { timezone: 'Asia/Riyadh', slots: ['13:00', '21:00'] },
    library: { root: '/Users/elamir/Desktop/AI Course' },
    examples: null,
};

/** A neutral English tenant: the defaults plus a product. */
export const ENGLISH_SETTINGS: StudioSettings = {
    ...defaultStudioSettings(),
    product: {
        name: 'Spreadsheets from Zero',
        url: 'https://example.com/spreadsheets?ref=studio',
        facts: ['12 lessons', '3 hours of video', 'Lifetime access'],
        dmBullets: ['12 lessons · 3 hours of video', 'Lifetime access'],
    },
};
