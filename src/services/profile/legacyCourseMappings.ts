/**
 * The owner's nine campaign mappings, as the dashboard shipped them until P13: the Arabic DM and public replies the
 * bulk import (Campaigns, "Import from CSV") seeded for his nine Udemy courses, keyed by the lower-case substring of
 * the course name that picks each one. They are his CONTENT, not code, and they are moving into his profile
 * (`offers[].campaign`, `scripts/seed-owner-offers.mts`); until that has been run they are what the platform owner's
 * `GET /api/profile/campaign-seeds` answers, and nobody else's ever (`campaignSeeds.ts`).
 *
 * The bytes are pinned by `__golden__/elamir/campaigns.course-mappings.json` (golden.test.ts): the key order is the order the
 * import tries them in (the first key the name contains wins, so 'problem solving' beats 'c#'), and a changed character
 * fails there. This file is the one place the nine live in code; the dashboard has none.
 *
 * Delete this file (and the fallback in `campaignSeeds.ts`) once the owner's stored profile carries the same nine and the
 * repo-wide owner-marker guard (P15) no longer needs to allow it.
 */

/** One mapping, in the shape the dashboard's `COURSE_MAPPINGS` had: two joined lists (", " and " | ") and the DM. */
export interface LegacyCourseMapping {
    triggerKeywords: string;
    dmTemplate: string;
    publicReplies: string;
}

export const LEGACY_COURSE_MAPPINGS: Readonly<Record<string, Readonly<LegacyCourseMapping>>> = Object.freeze({
    'agentic ai': {
        triggerKeywords: 'ذكاء اصطناعي, ايجنتك, عميل ذكي, agentic ai, ai agent',
        dmTemplate: `أهلاً بك {username}! 👋\nسعيد جداً باهتمامك بدورة "Agentic AI: الدليل العملي لبناء ما تحتاجه بالذكاء الاصطناعي". 🤖🚀\n\nهذا هو رابط التسجيل المجاني المباشر الخاص بك (الكوبون مفعّل تلقائياً):\n🔗 {url}\n\n💡 الكوبون صالح لفترة محدودة ولـ 100 مقعد فقط. سارع بالتسجيل واستمتع بالرحلة التعليمية!\nإذا كان لديك أي استفسار، أنا هنا دائماً لمساعدتك. بالتوفيق! ✨`,
        publicReplies: 'تم إرسال رابط الدورة والتفاصيل إلى الخاص بك يا {username}! تفقد رسائلك 📩🤖 | أهلاً بك {username}! شيك الخاص أرسلت لك كوبون التسجيل المجاني 🚀✨ | تم الإرسال على الخاص بنجاح! بالتوفيق في رحلتك التعليمية 🎓🌟',
    },
    'golang': {
        triggerKeywords: 'جولانج, كورس جو, لغة جو, golang, go lang',
        dmTemplate: `أهلاً بك {username}! 👋\nسعيد باهتمامك بتعلم لغة Go القوية مع دورة "GoLang Course: Learn Go in Arabic". 🐹🚀\n\nإليك رابط التسجيل المجاني المباشر الخاص بك (الكوبون مفعّل):\n🔗 {url}\n\n💡 الكوبون مخصص لـ 100 طالب وصالح لفترة محدودة. سجل الآن لتبدأ في بناء تطبيقات عالية الأداء!\nأراك داخل الدورة! 🎓✨`,
        publicReplies: 'شيك الخاص يا {username}! أرسلت لك رابط الدورة المجاني 🐹📩 | تم إرسال كوبون لغة Go إلى الخاص بك بنجاح! بالتوفيق 🚀 | أهلاً {username}، تفقد صندوق الوارد للبدء فوراً! 🎓💡',
    },
    'swift': {
        triggerKeywords: 'سويفت, برمجة ايفون, تطبيقات ايفون, swift programming, swift arabic',
        dmTemplate: `أهلاً بك {username}! 👋\nخطوة رائعة لدخول عالم برمجة تطبيقات الآيفون والآيباد! 📱✨\nإليك رابط التسجيل المجاني المباشر في دورة "Swift Programming Language | in Arabic":\n🔗 {url}\n\n💡 الكوبون متاح لأول 100 مقعد فقط. لا تفوت الفرصة وابدأ الآن!\nبالتوفيق لك في مسيرتك البرمجية! 🚀`,
        publicReplies: 'أهلاً بك {username}! تم إرسال رابط كورس سويفت على الخاص 📩📱 | شيك الخاص يا {username} لتجد كوبون الدورة المجاني! 🚀✨ | تم الإرسال بنجاح! بالتوفيق في برمجة تطبيقات iOS 🍏💡',
    },
    'css3': {
        triggerKeywords: 'سي اس اس, تصميم ويب, css3, web design',
        dmTemplate: `أهلاً بك {username}! 👋\nهل أنت جاهز لتصميم مواقع ويب احترافية وجذابة؟ 🎨💻\nإليك رابط التسجيل المجاني المباشر في دورة "CSS3 For Beginners [In Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لفترة محدودة ومحدود بـ 100 عملية تسجيل.\nبالتوفيق وسأكون سعيداً برؤية تصميماتك! 🚀✨`,
        publicReplies: 'تم إرسال كوبون كورس CSS3 إلى الخاص بك يا {username}! 🎨📩 | تفقد الخاص {username} لتجد رابط التسجيل المجاني! 💻✨ | أهلاً بك! تم الإرسال بنجاح، بالتوفيق في مسيرتك في تصميم الويب 🚀🌟',
    },
    'html5': {
        triggerKeywords: 'اتش تي ام ال, بناء موقع, html5, html beginners',
        dmTemplate: `أهلاً بك {username}! 👋\nأول خطوة في تطوير الويب تبدأ من هنا! 🌐💻\nإليك رابط التسجيل المجاني المباشر لدورة "HTML5 For Beginners [In Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لأول 100 طالب مسجل فقط. احجز مقعدك الآن!\nبالتوفيق لك في بدايتك الموفقة! 🚀✨`,
        publicReplies: 'أرسلت لك رابط كورس HTML5 على الخاص يا {username}! 🌐📩 | تفقد رسائلك {username} للتسجيل في الدورة مجاناً! 🚀 | تم إرسال الكوبون بنجاح! بداية موفقة في تطوير الويب 💻✨',
    },
    'problem solving': {
        triggerKeywords: 'حل مسائل, بروبلم سولفينج, problem solving, c# problem',
        dmTemplate: `أهلاً بك {username}! 👋\nحل المسائل هو السلاح السري لكل مبرمج محترف! 🧠💻\nإليك رابط التسجيل المجاني في دورة "Problem Solving - with C# [in Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لـ 100 مقعد فقط. سجل الآن وابدأ بتدريب عقلك البرمجي!\nبالتوفيق لك! 🚀✨`,
        publicReplies: 'تم إرسال رابط كورس حل المسائل على الخاص يا {username}! 🧠📩 | تفقد الخاص {username} لتجد الكوبون المجاني! 🚀✨ | تم الإرسال بنجاح! تمنياتي لك بالتوفيق في صقل مهاراتك المنطقية 💻🌟',
    },
    'java': {
        triggerKeywords: 'كورس جافا, جافا, java for beginners, java arabic',
        dmTemplate: `أهلاً بك {username}! 👋\nتعلم واحدة من أكثر لغات البرمجة طلباً واستخداماً في الشركات! ☕️🚀\nإليك رابط التسجيل المجاني المباشر في دورة "Java for Beginners [in Arabic]":\n🔗 {url}\n\n💡 الكوبون مخصص لـ 100 طالب وصالح لفترة محدودة. سجل الآن لتبني أساساً قوياً!\nبالتوفيق لك! 🎓✨`,
        publicReplies: 'تم إرسال رابط كورس الجافا على الخاص يا {username}! ☕️📩 | شيك الخاص {username} للحصول على الكوبون المجاني 🚀 | تم الإرسال بنجاح! بالتوفيق في مسيرتك البرمجية 💻✨',
    },
    'python': {
        triggerKeywords: 'بايثون, بايثون للمبتدئين, python arabic, python course',
        dmTemplate: `أهلاً بك {username}! 👋\nالبداية الأسهل والأكثر متعة في عالم البرمجة هي لغة بايثون! 🐍🚀\nإليك رابط التسجيل المجاني لدورة "Python For Beginners [in Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لأول 100 طالب مسجل فقط. احجز مقعدك الآن!\nأتمنى لك رحلة ممتعة وموفقة! ✨`,
        publicReplies: 'شيك الخاص يا {username}! أرسلت لك رابط كورس بايثون المجاني 🐍📩 | تم إرسال الكوبون إلى الخاص بك بنجاح! بالتوفيق 🚀 | أهلاً {username}، تفقد صندوق الوارد للبدء فوراً! 🎓💡',
    },
    'c#': {
        triggerKeywords: 'سي شارب, كورس سي شارب, csharp, c# beginners',
        dmTemplate: `أهلاً بك {username}! 👋\nتعلم لغة C# القوية لبناء تطبيقات سطح المكتب، الألعاب، والمواقع! 🎮💻\nإليك رابط التسجيل المجاني المباشر لدورة "C# For Beginners [in Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لـ 100 مقعد فقط ولفترة محدودة. احرص على التسجيل الآن!\nبالتوفيق وسأكون سعيداً بمتابعة تقدمك! 🚀✨`,
        publicReplies: 'تم إرسال رابط كورس سي شارب على الخاص يا {username}! 💻📩 | تفقد رسائل الخاص {username} لتجد الكوبون المجاني 🚀 | تم الإرسال بنجاح! بالتوفيق في مسيرتك البرمجية 🎓🌟',
    },
});
