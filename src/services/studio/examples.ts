/**
 * The built-in few-shot examples (STUDIO.md §7, §10.3): used when a tenant hasn't approved
 * examples of its own (`settings.examples` is null).
 *
 * Arabic: three approved carousels, copied exactly from
 * aicourse-captions/src/carousel/posts/{ChatVsAgent,ContextPyramid,LocalAI}.ts, formatting included, so a diff
 * against the originals stays empty. English: one neutral carousel written for this file.
 *
 * They are the target for quality, density and structure. Their CTA lines and facts belong to
 * their author, and their shot names to a static shot library, not to any draft's `shots` map:
 * validate them against `builtInExampleShotNames`.
 */
import type { Carousel } from './carouselTypes.js';

/** Lesson 1.1, "why chat is dead": the course's thesis, told as the four differences on its slide. */
export const chatVsAgent: Carousel = {
  id: "ChatVsAgent",
  accent: "#FFD60A",
  keyword: "وكيل",
  slides: [
    {
      kind: "cover",
      kicker: "التحوّل الوكيلي",
      title: "الدردشة ماتت… وبدأ عصر الوكيل",
      highlight: "عصر الوكيل",
      subtitle: "٤ فروق تغيّر طريقة استخدامك للذكاء الاصطناعي",
      shot: { name: "chat-dead" },
    },
    {
      kind: "compare",
      title: "روبوت المحادثة ضد الوكيل",
      left: {
        label: "الدردشة",
        items: ["تنتظر أمرك وبس", "تنسى اللي قلته قبل شوي", "مهمة وحدة كل مرة", "أنت تشتغل، وهي تساعد"],
      },
      right: {
        label: "الوكيل",
        items: ["يخطّط وينفّذ بنفسه", "يتذكّر هدفك البعيد", "يستخدم أدوات ويتحرّك", "هو يشتغل، وأنت تدير"],
      },
    },
    {
      kind: "point",
      n: 1,
      title: "الدردشة تجاوبك… الوكيل ينفّذ لك",
      body: "تسأل الدردشة «وش أفضل سماعة؟» فتعطيك رأي. تعطي الوكيل هدف، فيبحث ويقارن ويسلّمك تقرير جاهز.",
    },
    {
      kind: "prompt",
      title: "جرّب تكلّمه كوكيل",
      label: "انسخ البرومبت",
      prompt:
        "حلّل سوق [السماعات اللاسلكية]: حدّد أفضل ٥ موديلات، وقارن أسعارها وتوفّرها، وسلّمني تقرير مختصر بنقاط، وفي آخره توصيتك لميزانية [٥٠٠ ريال].",
      note: "هدف كامل بدل سؤال واحد. هذا الفرق كله",
    },
    {
      kind: "list",
      title: "وش سوّى الوكيل بدالك؟",
      items: [
        { icon: "🔎", text: "بحث في أكثر من مصدر", sub: "بدل ما تفتح عشر تبويبات بنفسك" },
        { icon: "📊", text: "قارن الموديلات والأسعار", sub: "وقسّمها لفئات حسب الميزانية" },
        { icon: "📦", text: "شيّك على التوفّر", sub: "وين موجود وبكم" },
        { icon: "📝", text: "سلّمك تقرير جاهز", sub: "نقاط مرتّبة تقرأها في دقيقة" },
      ],
    },
    {
      kind: "point",
      n: 2,
      title: "أنت صرت المدير",
      body: "مع الدردشة أنت تسوّي الشغل وهي تساعد. مع الوكيل هو يسوّي الشغل، وأنت تراجع وتقرّر.",
      tip: "ابدأ كل طلب بالنتيجة اللي تبيها، مو بالسؤال",
    },
    {
      kind: "stat",
      value: "٣٤",
      label: "درس بالعربي على هذا التحوّل",
      body: "من أول وكيل تبنيه بنفسك، لين متجر إلكتروني كامل وتطبيقات تنشرها باسمك.",
    },
    { kind: "cta", promise: "الكورس كامل مبني على هذا التحوّل" },
  ],
  captions: {
    instagram: `الدردشة ماتت 💬⚰️ وبدأ عصر الوكيل ⚡

الفرق اللي أغلب الناس ما انتبهوا له:
💬 الدردشة تجاوبك وتنتظر سؤالك الجاي
⚡ الوكيل ياخذ هدفك، يخطّط، يستخدم الأدوات، ويسلّمك النتيجة

اسحب وشوف الفروق الأربعة + برومبت تجرّبه بنفسك 👈

احفظ المنشور 🔖 وارسله لصاحبك اللي لسه يستخدم الذكاء الاصطناعي كدردشة

اكتب "وكيل" بالتعليقات ويوصلك رابط الكورس بالخاص 📩

#الذكاء_الاصطناعي #AgenticAI #وكلاء_الذكاء_الاصطناعي #ChatGPT #تقنية`,
    tiktokTitle: "الدردشة ماتت… وبدأ عصر الوكيل ⚡",
    tiktok: `الدردشة ماتت… وبدأ عصر الوكيل ⚡

💬 الدردشة تجاوبك
⚡ الوكيل ينفّذ لك: يخطّط، يستخدم الأدوات، ويسلّمك النتيجة جاهزة

اسحب وخذ البرومبت، جرّبه بنفسك 👈

وأنت؟ تستخدمه كدردشة ولا كوكيل؟ 👇

📚 الكورس كامل بالعربي — رابطه في البايو 🔗

#الذكاء_الاصطناعي #AgenticAI #تعلم_على_تيك_توك #LearnOnTikTok #تقنية`,
  },
};

/** Lesson 1.2: the prompt pyramid and its five-part prompt (role, task, context, format, constraints). */
export const contextPyramid: Carousel = {
  id: "ContextPyramid",
  accent: "#FF8A3D",
  keyword: "سياق",
  slides: [
    {
      kind: "cover",
      kicker: "هرم السياق",
      title: "ليش جواب الذكاء الاصطناعي عام؟",
      highlight: "عام؟",
      subtitle: "لأن طلبك ناقص. وهذا الهرم يكمّله في ٥ طبقات",
      shot: { name: "context-pyramid" },
    },
    {
      kind: "compare",
      title: "نفس الطلب… بفرق السياق",
      left: {
        label: "طلب ناقص",
        items: ["«اكتب لي بوست»", "ما يعرف مين أنت", "ما يعرف لمين يكتب", "جواب عام تعيده ٥ مرات"],
      },
      right: {
        label: "بهرم السياق",
        items: ["دور ومهمة واضحة", "سياق عنك وعن منتجك", "جمهور وشكل محدد", "جواب جاهز من أول مرة"],
      },
    },
    {
      kind: "list",
      title: "الهرم طبقة طبقة",
      items: [
        { icon: "🎭", text: "الدور", sub: "مين يكون؟ «خبير تسويق بخبرة ١٠ سنوات»" },
        { icon: "🎯", text: "المهمة", sub: "وش تبيه يسوّي بالضبط؟ واضحة ومحددة" },
        { icon: "🧩", text: "السياق", sub: "المعلومات اللي يحتاجها: منتجك، جمهورك، هدفك" },
        { icon: "📐", text: "التنسيق", sub: "شكل النتيجة: جدول، نقاط، أو كود" },
        { icon: "🚧", text: "القيود", sub: "الطول، النبرة، والأشياء اللي لا يسوّيها" },
      ],
    },
    {
      kind: "point",
      n: 1,
      title: "الدور يغيّر كل شي",
      body: "نفس السؤال يطلع له جواب مختلف لو قلت «أنت محاسب» أو «أنت معلّم». الدور يحدد المستوى والمصطلحات والزاوية.",
    },
    {
      kind: "point",
      n: 2,
      title: "السياق = اللي في راسك",
      body: "الذكاء الاصطناعي ما يعرف منتجك ولا جمهورك ولا هدفك. كل معلومة تضيفها توفّر عليك جولة تعديل كاملة.",
      tip: "اكتب له كأنك تشرح لموظف جديد في أول يوم",
    },
    {
      kind: "prompt",
      title: "القالب جاهز، عبّي الفراغات",
      label: "انسخ البرومبت",
      prompt:
        "الدور: أنت [خبير تسويق رقمي].\nالمهمة: اكتب [٣ منشورات إنستقرام] عن [منتجي].\nالسياق: [وصف المنتج، والجمهور، والهدف].\nالتنسيق: [جدول فيه الفكرة والنص والهاشتاقات].\nالقيود: [لهجة بيضاء، أقل من ٨٠ كلمة، بدون مبالغة].",
      note: "احفظه، وبدّل اللي بين الأقواس بس",
    },
    {
      kind: "stat",
      value: "٥",
      label: "طبقات تفرق بين جواب عام وجواب جاهز",
      body: "في الكورس نطبّقها على مشروع حقيقي: نفس الطلب مرة بدون الهرم ومرة معه، وتشوف الفرق بعينك.",
    },
    { kind: "cta", promise: "شرحته بالتطبيق في أول قسم من الكورس" },
  ],
  captions: {
    instagram: `ليش الذكاء الاصطناعي يعطيك جواب عام؟ 🤔
لأن طلبك ناقص.

هرم السياق يحوّل «اكتب لي بوست» لطلب يطلّع لك نتيجة جاهزة من أول مرة:
🎭 الدور ← 🎯 المهمة ← 🧩 السياق ← 📐 التنسيق ← 🚧 القيود

القالب كامل في الصور، انسخه وجرّب 👈

احفظ المنشور 🔖 وارجع له كل مرة تكتب برومبت

اكتب "سياق" بالتعليقات ويوصلك رابط الكورس بالخاص 📩

#الذكاء_الاصطناعي #هندسة_الأوامر #PromptEngineering #ChatGPT #انتاجية`,
    tiktokTitle: "ليش جواب الذكاء الاصطناعي عام؟ 🤔",
    tiktok: `ليش جواب الذكاء الاصطناعي عام؟ لأن طلبك ناقص 🤔

هرم السياق في ٥ طبقات:
🎭 الدور
🎯 المهمة
🧩 السياق
📐 التنسيق
🚧 القيود

القالب جاهز في الصور، احفظه 🔖

وش أكثر طبقة كنت تنساها؟ 👇

📚 الكورس كامل بالعربي — رابطه في البايو 🔗

#الذكاء_الاصطناعي #PromptEngineering #تعلم_على_تيك_توك #LearnOnTikTok #ChatGPT`,
  },
};

/** Section 8, "Privacy fortress: Local AI": why go local (8.1), LM Studio (8.2), local RAG (8.3). */
export const localAI: Carousel = {
  id: "LocalAI",
  accent: "#22D39A",
  keyword: "محلي",
  slides: [
    {
      kind: "cover",
      kicker: "الذكاء الاصطناعي المحلي",
      title: "ملفاتك السرية… ما تطلع من جهازك",
      highlight: "ما تطلع من جهازك",
      subtitle: "ذكاء اصطناعي شغّال على جهازك: بدون إنترنت وبدون اشتراك شهري",
      shot: { name: "local-hero" },
    },
    {
      kind: "compare",
      title: "السحابة ضد جهازك",
      left: {
        label: "الذكاء السحابي",
        items: ["ملفاتك تروح لسيرفر غيرك", "اشتراك تدفعه كل شهر", "النت فصل؟ وقف كل شي"],
      },
      right: {
        label: "الذكاء المحلي",
        items: ["ملفاتك ما تطلع من جهازك", "نماذج مفتوحة بدون اشتراك", "شغّال حتى بدون إنترنت"],
      },
    },
    {
      kind: "shot",
      title: "النت مفصول… وهو شغّال",
      shot: { name: "local-offline" },
      caption: "بدون إنترنت، والنموذج يجاوبك من جهازك. شوفه يقولها بنفسه",
    },
    {
      kind: "stat",
      value: "صفر",
      label: "ريال اشتراك شهري",
      body: "نماذج مفتوحة تنزّلها على جهازك وتشغّلها كل ما تبي، بدون ما تدفع على أي سؤال.",
    },
    {
      kind: "steps",
      title: "شغّله على جهازك بـ LM Studio",
      steps: [
        { title: "افتح LM Studio", body: "برنامج تشغّل فيه نماذج الذكاء الاصطناعي على جهازك" },
        { title: "نزّل نموذج مفتوح", body: "مثل Gemma أو Llama، من داخل البرنامج نفسه" },
        { title: "دردش معه", body: "زي أي شات تعرفه، بس كل شي يصير على جهازك" },
      ],
    },
    {
      kind: "point",
      title: "وش يعني RAG؟",
      body: "بدل ما النموذج يخمّن، يدوّر أول في ملفاتك (مثل PDF) على الأجزاء اللي تخص سؤالك، وبعدها يجاوبك منها.",
      shot: { name: "local-rag" },
      tip: "وملفاتك تبقى على جهازك، حتى وهو يقرأها",
    },
    {
      kind: "prompt",
      title: "خلّه يجاوب من ملفاتك بس",
      label: "انسخ البرومبت",
      prompt:
        "جاوب فقط من المستندات المرفقة، ولا تستخدم أي معلومة من برّاها. بعد كل معلومة اذكر اسم الملف ورقم الصفحة. إذا ما لقيت الجواب فيها قل «ما لقيته في المستندات» ولا تخمّن. سؤالي: [اكتب سؤالك هنا]",
      note: "أرفق ملفك في LM Studio والصق البرومبت قبل سؤالك",
    },
    { kind: "cta", promise: "قسم كامل عن الذكاء المحلي في الكورس" },
  ],
  captions: {
    instagram: `ملفاتك السرية… ما تطلع من جهازك 🔒

🔒 ذكاء اصطناعي على جهازك: ملفاتك الحساسة ما تطلع لأي سيرفر
💸 نماذج مفتوحة مثل Gemma وLlama، وبدون اشتراك شهري
📴 شغّال حتى والنت مفصول
📄 وبرومبت يخلّيه يجاوب من ملفاتك بس، اسحب وخذه 👈

احفظ المنشور 🔖

اكتب "محلي" بالتعليقات ويوصلك رابط الكورس بالخاص 📩

#الذكاء_الاصطناعي #AgenticAI #LocalAI #LMStudio #خصوصية #تقنية`,
    tiktokTitle: "ملفاتك السرية… ما تطلع من جهازك 🔒",
    tiktok: `ملفاتك السرية… ما تطلع من جهازك 🔒

ذكاء اصطناعي شغّال على جهازك أنت:
🔒 ملفاتك ما تطلع لأي سيرفر
💸 نماذج مفتوحة وبدون اشتراك شهري
📴 شغّال حتى بدون إنترنت

اسحب وخذ البرومبت اللي يخلّيه يجاوب من ملفاتك بس 👈

وأنت؟ ترفع ملفات شغلك للسحابة، ولا تفضّلها تبقى على جهازك؟ 👇

📚 الكورس كامل بالعربي — رابطه في البايو 🔗

#الذكاء_الاصطناعي #AgenticAI #LocalAI #تعلم_على_تيك_توك #LearnOnTikTok #تقنية`,
  },
};

/**
 * The neutral English built-in example, for tenants writing in English. Not any real creator's
 * post: generic advice with no product facts, and the default settings' CTA lines.
 */
export const goalNotQuestion: Carousel = {
  id: "GoalNotQuestion",
  accent: "#5B8CFF",
  keyword: "goal",
  slides: [
    {
      kind: "cover",
      kicker: "Better AI answers",
      title: "Stop asking AI questions",
      highlight: "questions",
      subtitle: "Give it a goal instead, and it hands back finished work",
    },
    {
      kind: "compare",
      title: "A question vs a goal",
      left: {
        label: "A question",
        items: ["\"What's the best laptop?\"", "You get an opinion", "You still do the work"],
      },
      right: {
        label: "A goal",
        items: ["\"Compare 3 laptops for me\"", "You get a table", "It does the legwork"],
      },
    },
    {
      kind: "point",
      n: 1,
      title: "Start with the result you want",
      body: "Say what the finished thing looks like: a table, a checklist, a draft. The AI can't aim at a target you never named.",
      tip: "Write the last line first: \"Give me…\"",
    },
    {
      kind: "list",
      title: "What a goal includes",
      items: [
        { icon: "🎯", text: "The outcome", sub: "What you'll hold at the end" },
        { icon: "🧩", text: "The context", sub: "Who it's for, and why" },
        { icon: "📐", text: "The format", sub: "A table, bullets or a draft" },
        { icon: "🚧", text: "The limits", sub: "Length, tone, and what to skip" },
      ],
    },
    {
      kind: "prompt",
      title: "Turn any question into a goal",
      label: "Copy the prompt",
      prompt:
        "My goal: [the result you want]. Context: [who it's for and why]. Give me [a table / a checklist / a draft] within [length and tone]. If anything is unclear, ask me one question first.",
      note: "Fill in the brackets, keep the order",
    },
    {
      kind: "shot",
      title: "The same ask, as a goal",
      shot: { name: "example-result" },
      caption: "One prompt with a goal, and the answer comes back as a finished comparison table",
    },
    {
      kind: "point",
      n: 2,
      title: "Then review, don't redo",
      body: "With a goal, your job moves from doing the work to checking it. Read it, correct one thing, and ask for the next version.",
    },
    { kind: "cta", promise: "The full method is in the course" },
  ],
  captions: {
    instagram: `Stop asking AI questions 🎯 Give it a goal.

❓ A question gets you an opinion
🎯 A goal gets you finished work: a table, a checklist, a draft

Swipe for the prompt that turns any question into a goal 👉

Save this post 🔖 for the next time an answer comes back generic

Comment "goal" and I'll DM you the link 📩

#AI #ChatGPT #Productivity #PromptEngineering #LearnAI`,
    tiktokTitle: "Stop asking AI questions. Give it a goal 🎯",
    tiktok: `Stop asking AI questions. Give it a goal 🎯

❓ A question gets you an opinion
🎯 A goal gets you finished work

Swipe and grab the prompt 👉

Do you ask AI questions, or give it goals? 👇

🔗 The full course is in my bio

#AI #ChatGPT #Productivity #LearnOnTikTok`,
  },
};

/** The Arabic built-ins, in the order the prompt shows them. */
export const ARABIC_EXAMPLES: readonly Carousel[] = [chatVsAgent, contextPyramid, localAI];

/** The English built-in. */
export const ENGLISH_EXAMPLES: readonly Carousel[] = [goalNotQuestion];

/** The few-shot examples for a tenant with none of its own. */
export function builtInExamples(language: 'ar' | 'en'): readonly Carousel[] {
    return language === 'ar' ? ARABIC_EXAMPLES : ENGLISH_EXAMPLES;
}

/** Every shot name the built-in examples use: their `shotNames` for `validateCarousel`. */
export const builtInExampleShotNames: ReadonlySet<string> = new Set(
    [...ARABIC_EXAMPLES, ...ENGLISH_EXAMPLES].flatMap((c) =>
        c.slides.flatMap((s) => ('shot' in s && s.shot ? [s.shot.name] : [])),
    ),
);
