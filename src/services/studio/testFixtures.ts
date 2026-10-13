/**
 * Test fixtures for the Studio writer: two tenants' settings. Imported by tests only.
 *
 * `ELAMIR_SETTINGS` holds ElAmir's values exactly as his tenant's seed should (STUDIO.md §8, and
 * the examples in §10.2's comments). Production code never reads it: v1.1 forbids hardcoding a
 * tenant, so his values reach the writer only through his `studio_settings` row.
 * `ENGLISH_SETTINGS` is a neutral English tenant built on the defaults.
 */
import type { GrowthSettings, StudioLesson } from '../../db/rows.js';
import type { ReelInsight } from '../monteur/analyst.js';
import type { ReelEvidenceSet } from '../monteur/reelEvidence.js';
import type { PickedClip, TranscriptLine } from '../monteur/transcript.js';
import type { GenSource, LessonRow, Moment } from './generate.js';
import { DEFAULT_PALETTE, defaultInfographicConfig, defaultMonteurConfig, defaultStudioSettings, type StudioSettings } from './settingsTypes.js';

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
    monteur: { ...defaultMonteurConfig(), post_at: ['19:00'] },
    infographic: defaultInfographicConfig(),
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

// ─── The owner's tenant, for the golden prompt tests (src/services/profile/golden.test.ts) ──────────
//
// Everything below is the owner's real configuration as the repo already holds it, so a builder
// given these inputs writes the exact text it writes for his tenant in production. Production code
// never imports this file.

/**
 * The owner's DM agent: the persona and knowledge base `schema_migration_v2.sql` (lines 45-61, the
 * `INSERT INTO ai_agents … SELECT … FROM creators`) wrote into his row. `golden.test.ts` parses that
 * migration and holds this copy to it, so a typo here fails a test instead of drifting.
 */
export const ELAMIR_AGENT = {
    system_prompt: `أنت مساعد ذكي ولطيف للاستاذ الأمير منصور (ElAmir Mansour)، مهندس البرمجيات وصانع المحتوى التعليمي. مهمتك هي الإجابة على استفسارات الطلاب والمتابعين باللغة العربية بأسلوب ودود وتشجيعهم على التعلم. استخدم المعلومات المتاحة في قاعدة المعرفة لتقديم تفاصيل عن الكورسات، أو توجيههم لقناته على اليوتيوب وحسابه على لينكد إن. عند الاقتضاء، قم بعرض الكورسات المناسبة في صورة كروت أو خيارات سريعة لمساعدتهم على الضغط والوصول مباشرة.`,
    knowledge_base: `كورسات اليوديمي المتاحة:
1. كورس أساسيات البرمجة ولغة C# [باللغة العربية]: يغطي المفاهيم الأساسية، البرمجة كائنية التوجه (OOP)، وهياكل البيانات والبرمجة للمبتدئين. رابط الكورس على الملف الشخصي: udemy.com/user/elamir-mahmoud-mansour
2. كورس هياكل البيانات والخوارزميات [باللغة العربية]: يغطي المصفوفات، القوائم، المكدس، الطابور، الأشجار، خوارزميات البحث والترتيب، وتعقيد الوقت (Big O). الرابط: udemy.com/user/elamir-mahmoud-mansour
3. معسكر حل المشكلات البرمجية (Problem Solving) [باللغة العربية]: يحتوي على تدريبات مكثفة على حل التحديات البرمجية لإعداد الطلاب للمقابلات الفنية والمسابقات. الرابط: udemy.com/user/elamir-mahmoud-mansour

روابط التواصل المهني والاجتماعي:
- حساب لينكد إن: linkedin.com/in/elamir-mansour
- قناة اليوتيوب: youtube.com/@ElAmir (تحتوي على شروحات برمجية مجانية في تطوير تطبيقات iOS ولغة سويفت وأدوات الذكاء الاصطناعي)`,
};

/**
 * A realistic stand-in for the owner's Growth settings: his row is not in the repo, so the keywords
 * and the audience follow GROWTH.md §1's examples, and the hashtag set and timezone the growth tests'.
 * The goals are the brief's own, 10k followers or 1M views. The live row is what the P6 parity script
 * checks; this pins the code.
 */
export const ELAMIR_GROWTH: GrowthSettings = {
    keywords: ['ذكاء اصطناعي', 'برومبت', 'وكيل ذكي', 'Agentic AI', 'NotebookLM'],
    hashtag_sets: [
        { name: 'AI', tags: ['#ذكاء_اصطناعي', '#الذكاء_الاصطناعي', '#AI'] },
        { name: 'Prompts', tags: ['#برومبت', '#PromptEngineering', '#Gemini'] },
        { name: 'Tools', tags: ['#NotebookLM', '#LMStudio', '#ChatGPT'] },
    ],
    competitors: ['rival.one', 'rival.two'],
    audience: { countries: ['SA', 'AE', 'EG'], languages: ['ar'], timezone: 'Asia/Riyadh' },
    goal_followers: 10_000,
    goal_views: 1_000_000,
};

/** What `seoForWriter` hands the Studio's writer for a tenant with these Growth settings. */
export const ELAMIR_SEO = {
    keywords: [...ELAMIR_GROWTH.keywords],
    hashtags: [...new Set(ELAMIR_GROWTH.hashtag_sets.flatMap((set) => set.tags))],
};

/**
 * The owner's whole Studio settings as `scripts/seed-studio-settings.mjs` writes them (its
 * `STUDIO_SETTINGS`, line 25), copied verbatim: importing the script would be safe, but it is
 * untyped JavaScript. It differs from `ELAMIR_SETTINGS` where it matters: only the seed pins the
 * infographic brand (the other has the neutral default), and its guide, facts and bullets are the
 * ones his row holds. `golden.test.ts` imports the script and holds this copy to it.
 */
export const ELAMIR_SEED_SETTINGS: StudioSettings = {
    brand: {
        name: 'Agentic AI بالعربي',
        signature: { latin: 'AGENTIC AI', local: 'بالعربي' },
        palette: [
            '#FFD60A', '#FF8A3D', '#22C7F0', '#FF5FA2', '#B06AFF', '#FFB020', '#A3E635',
            '#F0ABFC', '#FF3B5C', '#5EEAD4', '#22D39A', '#5B8CFF', '#FF6B6B',
        ],
        colors: { ink: '#08080A', paper: '#FAFAFA', muted: '#8A8A93' },
        fonts: { display: 'Cairo', mono: 'JetBrains Mono' },
        direction: 'rtl',
        theme: 'dark-grid',
    },
    voice: {
        language: 'ar',
        digits: 'arabic-indic',
        guide: [
            'Write in a light Gulf / white Arabic dialect: warm and direct, the way a Saudi creator talks to followers.',
            'Never formal MSA, never heavy slang.',
            'Use Arabic-Indic digits (٣ not 3) everywhere in Arabic text.',
            'Lead with the result the viewer gets, then name the tool that gets it.',
            'Short lines: one idea per line, one point per slide.',
            'Product and tool names stay in English (NotebookLM, Gemini, Stitch).',
            'No invented features or numbers: every claim comes from the lesson.',
            'TikTok copy points to the link in the bio («رابطه في البايو»), never to the comments.',
        ].join('\n'),
        // The course's MCP section is not published yet.
        avoid: ['MCP'],
    },
    product: {
        name: 'Agentic AI: الدليل العملي لبناء ما تحتاجه بالذكاء الاصطناعي',
        url: 'https://www.udemy.com/course/agentic-ai-arabic/?referralCode=02A626DDDA3FDAB6AB34',
        facts: ['٣٤ درس', '٥ ساعات و٤٠ دقيقة', 'شهادة إتمام'],
        dmBullets: [
            '✅ ٣٤ درس · ٥ ساعات و٤٠ دقيقة',
            '✅ ١١ قسم — كل قسم تطبيق عملي من الصفر',
            '✅ شهادة إتمام + وصول مدى الحياة',
            '✅ ضمان استرجاع ٣٠ يوم من Udemy',
        ],
    },
    cta: {
        instagramAsk: 'اكتب "{keyword}" بالتعليقات ويوصلك رابط الكورس بالخاص 📩',
        tiktokLine: '📚 الكورس كامل بالعربي — رابطه في البايو 🔗',
        // STUDIO.md §8, with its two topical lines, the link and the ✅ lines as placeholders.
        dmTemplate: [
            'هلا {username} 👋',
            '',
            '{question}',
            '',
            '{pitch}',
            '',
            '🎬 شوف الكورس كامل من هنا:',
            '{url}',
            '',
            'داخل الكورس:',
            '{bullets}',
            '',
            'عندك سؤال؟ رد على هالرسالة — أنا أرد بنفسي ✌️',
        ].join('\n'),
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
    // MONTEUR.md §1. Off until the folder is chosen from the dashboard; the daily run at 07:00 and
    // the posting slot at 19:00 are Riyadh times, the slot the views analysis found best.
    monteur: {
        enabled: false,
        source: 'folder',
        mode: 'review',
        // The owner's choice (2026-09-28): the pick, the copy, the edits and the Analyst by Claude on his Mac, never Gemini.
        brain: 'claude_mac',
        // The edits' look (MONTEUR.md §6.2): 'classic', or 'paper' (unfolding cards, drawn icons).
        style: 'classic',
        // The Editor's human touches (MONTEUR.md §6.2): camera cuts, doodles, highlights, transitions, freeze-frames.
        human: true,
        folder: null,
        run_at: '07:00',
        videos_per_run: 1,
        reels_per_video: 1,
        platforms: ['instagram', 'facebook', 'tiktok'],
        post_at: ['19:00'],
        min_seconds: 20,
        max_seconds: 45,
    },
    // The personal brand on every infographic (v31): elamirmansour.dev's colours and handles,
    // in Modern Standard Arabic (the owner asked for فصحى, 2026-10-12). The portrait is uploaded
    // from the Infographics screen, so it starts empty here.
    infographic: {
        name: { ar: 'الأمير منصور', en: 'ElAmir Mansour' },
        site: 'elamirmansour.dev',
        handle: '@elamir.mansour',
        socials: ['instagram', 'youtube', 'linkedin', 'x', 'tiktok'],
        primary: '#0E3B5C',
        accent: '#F2A33A',
        photo_url: null,
        theme: 'dark',
        language: 'ar',
        platforms: ['instagram', 'facebook', 'youtube'],
    },
};
// ─── Inputs the golden tests give the builders that need more than settings ──────────────────
//
// Taken from what the builders' own tests use (generate.test.ts, pick.test.ts, coach.test.ts), and
// kept here so the later refactor PRs feed their new paths the very same inputs.

const LESSON_ID = '11111111-1111-4111-8111-111111111111';
const moment = (n: number, clean: boolean, t: number, description: string): Moment => ({
    id: `0000000${n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, lesson_id: LESSON_ID, t, description, kind: 'result', clean, thumb_url: null,
});

/** One indexed lesson with five moments (M1…M5 by time; M3 is not clean), as generate.test.ts has it. */
export const GOLDEN_LESSON: LessonRow = {
    id: LESSON_ID, lesson_no: '8.3', title: 'Local RAG with LM Studio', section_no: 8,
    section_title: 'Chapter 8 - Local RAG lmstudio', status: 'indexed',
    notes: {
        summary: 'تشغيل نموذج على جهازك والإجابة من ملفاتك.',
        points: [{ title: 'ليش محلي', detail: 'الملفات ما تطلع من الجهاز', t: 10 }, { title: 'LM Studio', detail: 'تنزيل نموذج مفتوح', t: 60 }],
        prompts: [{ text: 'جاوب فقط من المستندات المرفقة', t: 210 }],
        tools: ['LM Studio'],
        demos: [{ title: 'بدون إنترنت', result: 'النموذج يجاوب والنت مفصول', t: 95 }],
    },
};
export const GOLDEN_MOMENTS: Moment[] = [
    moment(1, true, 12, 'A laptop with a lock on screen'),
    moment(2, true, 95.5, 'The model answering with Wi-Fi off'),
    moment(3, false, 130, 'Arrows scribbled over the settings'),
    moment(4, true, 200, 'RAG answering from a PDF'),
    moment(5, true, 250, 'The model list in LM Studio'),
];
export const GOLDEN_SOURCES: GenSource[] = [{ lesson: GOLDEN_LESSON, moments: GOLDEN_MOMENTS }];
/** A second lesson that is not indexed yet, for the week planner's catalog. */
export const GOLDEN_UNINDEXED_LESSON: LessonRow = {
    id: '22222222-2222-4222-8222-222222222222', lesson_no: '9.1', title: 'Agents that use tools', section_no: 9,
    section_title: 'Chapter 9 - Tool use', status: 'pending', notes: null,
};

/** A short transcript as the Monteur reads it: the same lesson, spoken to camera. */
export const GOLDEN_LINES: TranscriptLine[] = [
    { n: 1, first: 0, last: 7, t0: 0, t1: 4.2, text: 'ملفاتك السرية ما لازم تطلع من جهازك أبداً.', forcedStart: false, forcedEnd: false },
    { n: 2, first: 8, last: 24, t0: 4.6, t1: 11.8, text: 'شغّل نموذج ذكاء اصطناعي محلي في LM Studio وهو يجاوب من ملفاتك والنت مفصول.', forcedStart: false, forcedEnd: false },
    { n: 3, first: 25, last: 36, t0: 12.4, t1: 19, text: 'أول خطوة: نزّل النموذج، وبعدين اسحب ملفاتك عليه.', forcedStart: false, forcedEnd: false },
    { n: 4, first: 37, last: 55, t0: 19.6, t1: 27.5, text: 'ثاني خطوة: اسأله عن أي شي في المستند، وهو يجاوبك بدون ما يرسل شي لأي سيرفر.', forcedStart: false, forcedEnd: false },
    { n: 5, first: 56, last: 66, t0: 28.1, t1: 34, text: 'والنتيجة: خصوصية كاملة وسرعة ما تتوقعها.', forcedStart: false, forcedEnd: false },
];

const clip = (rank: number, startLine: number, endLine: number, title: string): PickedClip => {
    const lines = GOLDEN_LINES.slice(startLine - 1, endLine);
    return {
        rank, startLine, endLine, startWord: lines[0]!.first, endWord: lines.at(-1)!.last, start: lines[0]!.t0, end: lines.at(-1)!.t1,
        title, hook: lines[0]!.text, why: 'خصوصية كاملة', score: Math.round(rank / 1.8),
        scores: { hook: 3, alone: 3, payoff: 2, send: 3 }, hookType: 'promise', text: lines.map((l) => l.text).join(' '),
    };
};
/** Two picked clips of that transcript, as the Marketer is asked to write for them. */
export const GOLDEN_CLIPS: PickedClip[] = [
    clip(1, 1, 3, 'نموذج محلي يجاوب من ملفاتك'),
    clip(2, 3, 5, 'خطوتين وملفاتك ما تطلع'),
];

/** The Analyst's rules and the creator's own reels, as the Monteur's prompts quote them. */
export const GOLDEN_LESSONS: StudioLesson[] = [
    { rule: 'ابدأ بالنتيجة في أول جملة، مو باسم الأداة', evidence: 'ثلاثة من أفضل أربعة ريلز بدأت بنتيجة: ٦٢٪ أقل تخطياً في ٣ ثوانٍ' },
    { rule: 'اجعل الريل بين ٢٥ و٣٥ ثانية', evidence: 'متوسط المشاهدة ٢١ ثانية للريلز بين ٢٥ و٣٥' },
];
export const GOLDEN_REEL_EVIDENCE: ReelEvidenceSet = {
    best: [{ views: 48200, skipRate: 41.5, title: 'الذكاء الاصطناعي على ملفاتك', topic: 'نموذج محلي', opening: 'ملفاتك السرية ما لازم تطلع من جهازك' }],
    worst: [{ views: 310, skipRate: null, title: null, topic: null, opening: 'هنا جينا نشوف الإعدادات' }],
    held: [{ views: 12900, skipRate: 38, title: 'برومبت واحد يلخص كتاب', topic: 'تلخيص', opening: 'برومبت واحد يلخص لك أي كتاب' }],
    lost: [{ views: 2400, skipRate: 91.2, title: 'مقدمة عن الوكلاء', topic: null, opening: 'أهلاً بكم في هذا الفيديو الجديد' }],
};
export const GOLDEN_REELS: ReelInsight[] = [
    {
        id: 'ri-1', platform: 'instagram', media_type: 'REELS', published_at: new Date('2026-10-08T16:00:00Z'),
        caption: 'ملفاتك السرية ما لازم تطلع من جهازك 🔒\n\n#ذكاء_اصطناعي',
        metrics: { views: 48200, reach: 39100, skip_rate: 41.5, likes: 2100, comments: 96, shares: 410, saved: 880 },
    },
    {
        id: 'ri-2', platform: 'facebook', media_type: 'VIDEO', published_at: new Date('2026-10-06T16:00:00Z'),
        caption: 'برومبت واحد يلخص لك أي كتاب', metrics: { views: 3100, reach: 2800 },
    },
    {
        id: 'ri-3', platform: 'instagram', media_type: 'REELS', published_at: null,
        caption: null, metrics: {},
    },
];
