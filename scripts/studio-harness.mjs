#!/usr/bin/env node
/**
 * Carousel Studio preview harness.
 *
 * A tiny local server that serves `dashboard/` exactly as it ships and answers `/api/*` from
 * fixtures, so the Studio page (#/studio) can be opened, clicked through and screenshotted with
 * no database, no Gemini and no Mac worker. It speaks STUDIO.md §4 and §10.3: the same routes,
 * the same bodies, the same error shape (`4xx { error, problems? }`).
 *
 *   node scripts/studio-harness.mjs            # http://localhost:4178/
 *   node scripts/studio-harness.mjs --port 5000
 *
 * Open http://localhost:4178/ for the scenario list, or go straight to one:
 *
 *   /harness?s=ready&lang=en&to=/studio        # the create step, in English
 *   /harness?s=offline&lang=ar                 # worker offline, in Arabic
 *   /harness?s=ready&to=/studio?draft=d-ready  # the editor on a rendered draft
 *   /harness?lang=en&to=/help                  # the Help Center, which needs no fixtures
 *   /harness?lang=ar&to=/help/worker%23security  # a deep link to one section (%23 is the anchor's #)
 *
 * Query options: `s` scenario, `lang` ar|en, `to` the hash route, `theme` light|dark,
 * `gen` seconds a generation takes (default 8), `render` seconds a render takes (default 6).
 *
 * The session: the dashboard keeps its bearer token in localStorage under `auth_token`
 * (api.js reads it at load, before anything renders). `/harness` injects a script at the top
 * of <head> that seeds a fake token, and `/api/auth/me` answers as a platform admin who owns
 * one tenant, so the app shell boots straight past the login screen.
 *
 * Slide images are real renders from aicourse-captions (ChatVsAgent), served under
 * /api/uploads/…, and lesson moments use the real shot library as thumbnails. Override the
 * folders with STUDIO_RENDERS and STUDIO_SHOTS.
 *
 * State lives in memory and resets whenever /harness is opened. Writes behave like the real
 * API: POST /drafts leaves a `generating` row while it "writes", a render moves `rendering` →
 * `ready` after a few seconds while the worker is online, and stays queued while it is not.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

// ─── Config ─────────────────────────────────────────────────────────────────────────────
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = join(ROOT, 'dashboard');
const COURSE = join(os.homedir(), 'Desktop', 'AI Course', 'aicourse-captions');
const RENDERS = process.env.STUDIO_RENDERS || join(COURSE, 'out', 'carousel', 'ChatVsAgent');
const SHOTS = process.env.STUDIO_SHOTS || join(COURSE, 'public', 'shots');

function argValue(name) {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1];
}
const PORT = Number(argValue('--port') || process.env.PORT || 4178);

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const iso = (msFromNow = 0) => new Date(Date.now() + msFromNow).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// ─── Real images ────────────────────────────────────────────────────────────────────────
const listJpegs = (dir) => {
    try { return readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort(); } catch { return []; }
};
const IG_FILES = listJpegs(join(RENDERS, 'ig'));
const TT_FILES = listJpegs(join(RENDERS, 'tt'));
const SHOT_FILES = listJpegs(SHOTS);

const renderUrls = (which, count) => {
    const files = which === 'tt' ? TT_FILES : IG_FILES;
    const out = [];
    for (let i = 0; i < count; i++) out.push(`/api/uploads/${which}-${files.length ? files[i % files.length] : `${i + 1}.jpg`}`);
    return out;
};

// ─── Lessons: the real course's chapters, titles cleaned the way the scan cleans them ─────
const COURSE_LESSONS = [
    ['1.1', 1, 'Chapter 1 - Prompting', 'Why chat is dead', 612],
    ['1.2', 1, 'Chapter 1 - Prompting', 'The context pyramid', 540],
    ['1.3', 1, 'Chapter 1 - Prompting', 'Tool selection', 488],
    ['1.4', 1, 'Chapter 1 - Prompting', 'Customise your AI agent', 701],
    ['1.5', 1, 'Chapter 1 - Prompting', 'Build your prompt engineer', 655],
    ['2.1', 2, 'Chapter 2 - NotebookLM', 'NotebookLM, your full guide', 930],
    ['2.2', 2, 'Chapter 2 - NotebookLM', 'Talking to the NotebookLM podcast', 422],
    ['2.3', 2, 'Chapter 2 - NotebookLM', 'NotebookLM + Gemini', 515],
    ['3.1', 3, 'Chapter 3 - Stitch', 'Stitch: text to interface', 604],
    ['3.2', 3, 'Chapter 3 - Stitch', 'Sketch to app', 577],
    ['3.3', 3, 'Chapter 3 - Stitch', 'Fix Stitch with Nano Banana', 463],
    ['3.4', 3, 'Chapter 3 - Stitch', 'Stitch export to Figma', 390],
    ['4.1', 4, 'Chapter 4 - Opal', 'Build a mini app in natural language', 820],
    ['4.2', 4, 'Chapter 4 - Opal', 'Iterative refinement in Opal', 610],
    ['4.3', 4, 'Chapter 4 - Opal', 'Publishing mini apps', 355],
    ['5.1', 5, 'Chapter 5 - AI Studio', 'Your prompt designer agent', 742],
    ['5.2', 5, 'Chapter 5 - AI Studio', 'Video production with Veo', 588],
    ['5.3', 5, 'Chapter 5 - AI Studio', 'Slide deck automation', 501],
    ['6.1', 6, 'Chapter 6 - Antigravity', 'Downloading Antigravity and its models', 676],
    ['6.2', 6, 'Chapter 6 - Antigravity', 'An online store from one prompt', 1180],
    ['6.3', 6, 'Chapter 6 - Antigravity', 'Async orchestration', 845],
    ['6.4', 6, 'Chapter 6 - Antigravity', 'Antigravity and Nano Banana Pro', 530],
    ['7.1', 7, 'Chapter 7 - CodeWiki', 'Code Wiki overview', 480],
    ['7.2', 7, 'Chapter 7 - CodeWiki', 'Chat with a repo and draw diagrams', 566],
    ['8.1', 8, 'Chapter 8 - Local RAG lmstudio', 'Why go local with LLMs?', 452],
    ['8.2', 8, 'Chapter 8 - Local RAG lmstudio', 'LM Studio explained', 918],
    ['8.3', 8, 'Chapter 8 - Local RAG lmstudio', 'Local RAG: what it is, with an example', 874],
    ['9.1', 9, 'Chapter 9 - Enhancing your CV', 'CV optimiser with Opal', 640],
    ['9.2', 9, 'Chapter 9 - Enhancing your CV', 'A CV agent that tailors itself', 580],
    ['I.1', null, 'Introduction', 'Welcome to the course', 214],
    ['I.2', null, 'Introduction', 'How to get the most out of it', 190],
    ['G.1', null, 'Gemini apps', 'Gemini apps in five minutes', 305],
    ['G.2', null, 'Gemini apps', 'Gems you can reuse', 330],
    ['G.3', null, 'Gemini apps', 'Deep Research, start to finish', 412],
];

const lessonId = (no) => `l-${no.replace('.', '-').toLowerCase()}`;

/** 34 lessons; the first `indexed` are indexed, the next `indexing` are indexing, the rest new. */
function buildLessons({ indexed = 34, indexing = 0, failed = 0 } = {}) {
    return COURSE_LESSONS.map(([no, section, sectionTitle, title, duration], i) => {
        let status = 'new';
        if (i < indexed) status = 'indexed';
        else if (i < indexed + indexing) status = 'indexing';
        else if (i < indexed + indexing + failed) status = 'failed';
        return {
            id: lessonId(no), lesson_no: no, section_no: section, section_title: sectionTitle, title,
            video_path: `/Users/you/Course/${sectionTitle}/${title}.mp4`, duration_s: duration, status,
            indexed_at: status === 'indexed' ? iso(-3 * 24 * HOUR) : null,
            error: status === 'failed' ? 'Gemini could not read the video (it is longer than the upload limit).' : null,
            created_at: iso(-10 * 24 * HOUR), updated_at: iso(-3 * 24 * HOUR),
        };
    });
}

const MOMENT_TEXT = [
    ['A chat window that answers and then waits', 'ui'],
    ['The agent writing its own plan, step by step', 'result'],
    ['Five headphone models compared in a table', 'result'],
    ['The full prompt on screen, with placeholders', 'prompt'],
    ['Slide: chat versus agent, four differences', 'slide'],
    ['The finished report, full screen', 'result'],
    ['Settings panel where the tools are switched on', 'ui'],
    ['A code block the agent generated', 'code'],
    ['Browser tabs the agent opened while researching', 'ui'],
    ['Budget recommendation at the end of the report', 'result'],
    ['Instructor pointing at the plan (arrows drawn on it)', 'other'],
    ['Loading spinner while the model thinks', 'other'],
    ['The memory panel showing the long-term goal', 'ui'],
    ['Side-by-side: the vague answer and the finished report', 'slide'],
    ['Prompt template with [market] and [budget]', 'prompt'],
    ['Export button and the saved file', 'ui'],
];

/** 16 moments per lesson, thumbnails from the real shot library, three of them not clean. */
function buildMoments(lesson) {
    const offset = Math.abs([...lesson.id].reduce((n, c) => n + c.charCodeAt(0), 0)) % Math.max(1, SHOT_FILES.length);
    const span = Number(lesson.duration_s) || 600;
    return MOMENT_TEXT.map(([description, kind], k) => {
        const file = SHOT_FILES.length ? SHOT_FILES[(offset + k) % SHOT_FILES.length] : '';
        return {
            id: `${lesson.id}-m${k + 1}`,
            lesson_id: lesson.id,
            t: Math.round(((k + 1) / (MOMENT_TEXT.length + 1)) * span * 10) / 10,
            description,
            kind,
            clean: !(k === 10 || k === 11 || k === 15),
            thumb_url: file ? `/api/uploads/shot-${file}` : null,
        };
    });
}

function lessonNotes() {
    return {
        summary: 'يشرح الدرس الفرق بين أن تسأل الذكاء الاصطناعي سؤالاً وأن تعطيه هدفاً كاملاً. الدردشة تنتظر أمرك، والوكيل يخطط ويستخدم الأدوات ويسلّمك النتيجة.',
        points: [
            { title: 'الدردشة تجاوب، الوكيل ينفّذ', detail: 'السؤال يعطيك رأياً، والهدف يعطيك شغلاً منجزاً.', t: 42 },
            { title: 'ابدأ بالنتيجة', detail: 'قل له وش تبي تستلم في النهاية قبل أي شيء.', t: 131 },
            { title: 'أنت المدير', detail: 'هو يسوّي الشغل وأنت تراجع وتقرر.', t: 260 },
        ],
        prompts: [{ text: 'حلّل سوق [السماعات اللاسلكية] وسلّمني تقرير مختصر بنقاط.', t: 188 }],
        tools: ['Gemini', 'ChatGPT'],
        demos: [{ title: 'تقرير السماعات', result: 'مقارنة ٥ موديلات مع توصية للميزانية', t: 300 }],
    };
}

// ─── The carousel behind the real renders (aicourse-captions ChatVsAgent) ───────────────
const COVER_SHOT = `m-${lessonId('1.1')}-m1`;

function chatVsAgent() {
    return {
        id: 'ChatVsAgent',
        accent: '#FFD60A',
        keyword: 'وكيل',
        slides: [
            { kind: 'cover', kicker: 'التحوّل الوكيلي', title: 'الدردشة ماتت… وبدأ عصر الوكيل', highlight: 'عصر الوكيل', subtitle: '٤ فروق تغيّر طريقة استخدامك للذكاء الاصطناعي', shot: { name: COVER_SHOT } },
            { kind: 'compare', title: 'روبوت المحادثة ضد الوكيل', left: { label: 'الدردشة', items: ['تنتظر أمرك وبس', 'تنسى اللي قلته قبل شوي', 'مهمة وحدة كل مرة', 'أنت تشتغل، وهي تساعد'] }, right: { label: 'الوكيل', items: ['يخطّط وينفّذ بنفسه', 'يتذكّر هدفك البعيد', 'يستخدم أدوات ويتحرّك', 'هو يشتغل، وأنت تدير'] } },
            { kind: 'point', n: 1, title: 'الدردشة تجاوبك… الوكيل ينفّذ لك', body: 'تسأل الدردشة «وش أفضل سماعة؟» فتعطيك رأي. تعطي الوكيل هدف، فيبحث ويقارن ويسلّمك تقرير جاهز.' },
            { kind: 'prompt', title: 'جرّب تكلّمه كوكيل', label: 'انسخ البرومبت', prompt: 'حلّل سوق [السماعات اللاسلكية]: حدّد أفضل ٥ موديلات، وقارن أسعارها وتوفّرها، وسلّمني تقرير مختصر بنقاط، وفي آخره توصيتك لميزانية [٥٠٠ ريال].', note: 'هدف كامل بدل سؤال واحد. هذا الفرق كله' },
            { kind: 'list', title: 'وش سوّى الوكيل بدالك؟', items: [
                { icon: '🔎', text: 'بحث في أكثر من مصدر', sub: 'بدل ما تفتح عشر تبويبات بنفسك' },
                { icon: '📊', text: 'قارن الموديلات والأسعار', sub: 'وقسّمها لفئات حسب الميزانية' },
                { icon: '📦', text: 'شيّك على التوفّر', sub: 'وين موجود وبكم' },
                { icon: '📝', text: 'سلّمك تقرير جاهز', sub: 'نقاط مرتّبة تقرأها في دقيقة' },
            ] },
            { kind: 'point', n: 2, title: 'أنت صرت المدير', body: 'مع الدردشة أنت تسوّي الشغل وهي تساعد. مع الوكيل هو يسوّي الشغل، وأنت تراجع وتقرّر.', tip: 'ابدأ كل طلب بالنتيجة اللي تبيها، مو بالسؤال' },
            { kind: 'stat', value: '٣٤', label: 'درس بالعربي على هذا التحوّل', body: 'من أول وكيل تبنيه بنفسك، لين متجر إلكتروني كامل وتطبيقات تنشرها باسمك.' },
            { kind: 'cta', promise: 'الكورس كامل مبني على هذا التحوّل' },
        ],
        captions: {
            instagram: 'الدردشة ماتت 💬 وبدأ عصر الوكيل ⚡\n\nالفرق اللي أغلب الناس ما انتبهوا له:\n💬 الدردشة تجاوبك وتنتظر سؤالك الجاي\n⚡ الوكيل ياخذ هدفك، يخطّط، يستخدم الأدوات، ويسلّمك النتيجة\n\nاسحب وشوف الفروق الأربعة + برومبت تجرّبه بنفسك 👈\n\nاكتب "وكيل" بالتعليقات ويوصلك رابط الكورس بالخاص 📩\n\n#الذكاء_الاصطناعي #AgenticAI #تقنية',
            tiktokTitle: 'الدردشة ماتت… وبدأ عصر الوكيل ⚡',
            tiktok: 'الدردشة ماتت… وبدأ عصر الوكيل ⚡\n\n💬 الدردشة تجاوبك\n⚡ الوكيل ينفّذ لك: يخطّط، يستخدم الأدوات، ويسلّمك النتيجة جاهزة\n\n📚 الكورس كامل بالعربي — رابطه في البايو 🔗\n\n#الذكاء_الاصطناعي #تعلم_على_تيك_توك',
        },
    };
}

function carouselFor(title, accent) {
    const c = chatVsAgent();
    if (title) c.slides[0].title = String(title).slice(0, 34);
    if (accent) c.accent = accent;
    return c;
}

function shotsFor(carousel) {
    const shots = {};
    for (const slide of carousel.slides) {
        const name = slide && slide.shot && slide.shot.name;
        if (!name || !name.startsWith('m-')) continue;
        const lesson = name.slice(2).replace(/-m\d+$/, '');
        shots[name] = { lessonId: lesson, t: 38.2, zoom: 1.3, focusX: 0.5, focusY: 0.5, desc: 'A chat window that answers and then waits' };
    }
    return shots;
}

const DM = 'هلا {username} 👋\n\nتبي تخلي الذكاء الاصطناعي يشتغل بدالك بدل ما يجاوبك وبس؟\n\nالقسم الأول من الكورس يشرح لك الفرق بين الدردشة والوكيل خطوة بخطوة.\n\n🎬 شوف الكورس كامل من هنا:\nhttps://example.com/course?ref=harness\n\nداخل الكورس:\n✅ ٣٤ درس · ٥ ساعات و٤٠ دقيقة\n✅ شهادة إتمام + وصول مدى الحياة\n\nعندك سؤال؟ رد على هالرسالة ✌️';

// ─── Settings (STUDIO.md §10.2), seeded the way the operator's own tenant is ─────────────
function settingsFixture(root) {
    return {
        brand: {
            name: 'Agentic AI بالعربي',
            signature: { latin: 'AGENTIC AI', local: 'بالعربي' },
            palette: ['#FFD60A', '#7C5CFF', '#22C55E', '#FF6B6B', '#38BDF8'],
            colors: { ink: '#0B0B10', paper: '#F5F5F7', muted: '#8A8A99' },
            fonts: { display: 'Cairo', mono: 'JetBrains Mono' },
            direction: 'rtl',
            theme: 'dark-grid',
        },
        voice: {
            language: 'ar',
            guide: 'لهجة خليجية خفيفة. جمل قصيرة. النتيجة أولاً ثم الأداة. أرقام عربية. لا مبالغة ولا وعود.',
            digits: 'arabic-indic',
        },
        product: {
            name: 'Agentic AI: الدليل العملي',
            url: 'https://example.com/course?ref=harness',
            facts: ['٣٤ درس', '٥ ساعات و٤٠ دقيقة', 'شهادة إتمام'],
            dmBullets: ['✅ ٣٤ درس · ٥ ساعات و٤٠ دقيقة', '✅ شهادة إتمام + وصول مدى الحياة', '✅ ضمان استرجاع ٣٠ يوم'],
        },
        cta: {
            instagramAsk: 'اكتب "{keyword}" بالتعليقات ويوصلك رابط الكورس بالخاص 📩',
            tiktokLine: '📚 الكورس كامل بالعربي — رابطه في البايو 🔗',
            dmTemplate: 'هلا {username} 👋\n\n{question}\n\n{pitch}\n\n🎬 شوف الكورس كامل من هنا:\n{url}\n\nداخل الكورس:\n{bullets}\n\nعندك سؤال؟ رد على هالرسالة ✌️',
            slide: {
                igAsk: 'اكتب في التعليقات', igSub: 'ويوصلك الرابط بالخاص 📩', save: 'احفظ المنشور',
                ttHeadline: 'الكورس كامل بالعربي', ttPill: 'رابطه في البايو', ttSub: 'ادخل البروفايل واضغط الرابط 👆',
                follow: 'تابعني للمزيد', swipe: 'اسحب',
            },
        },
        schedule: { timezone: 'Asia/Riyadh', slots: ['13:00', '21:00'] },
        library: { root },
        examples: null,
    };
}

/** The next free 10:00Z / 18:00Z slots (13:00 / 21:00 Riyadh), skipping `taken`. */
function freeSlots(count, taken = []) {
    const out = [];
    const start = new Date();
    start.setUTCMinutes(0, 0, 0);
    for (let h = 0; out.length < count && h < 24 * 60; h++) {
        const at = new Date(start.getTime() + h * HOUR);
        if ((at.getUTCHours() === 10 || at.getUTCHours() === 18) && at.getTime() > Date.now() + 15 * MIN) {
            const stamp = at.toISOString();
            if (!taken.includes(stamp)) out.push(stamp);
        }
    }
    return out;
}

// ─── Drafts ─────────────────────────────────────────────────────────────────────────────
function draftRow(over) {
    return {
        id: 'd-x', status: 'ready', input: { lessonIds: [lessonId('1.1')], angle: 'auto', slides: 8 },
        carousel: null, shots: null, campaign: null, render: null, schedule: null, error: null,
        created_at: iso(-2 * HOUR), updated_at: iso(-2 * HOUR),
        ...over,
    };
}

function renderedDraft(id, over = {}) {
    const carousel = over.carousel || chatVsAgent();
    return draftRow({
        id,
        carousel,
        shots: shotsFor(carousel),
        campaign: { keyword: carousel.keyword, variants: ['الوكيل', 'وكلاء'], dm: DM, create: true },
        render: { ig: renderUrls('ig', carousel.slides.length), tt: renderUrls('tt', carousel.slides.length), rendered_at: iso(-50 * MIN), job_id: `j-${id}` },
        ...over,
    });
}

/** One draft in every status the table allows. */
function everyStatusDrafts() {
    const slots = freeSlots(4);
    return [
        draftRow({ id: 'd-generating', status: 'generating', input: { lessonIds: [lessonId('8.3')], angle: 'steps', slides: 8 }, created_at: iso(-25 * 1000), updated_at: iso(-25 * 1000) }),
        draftRow({
            id: 'd-rendering', status: 'rendering', input: { lessonIds: [lessonId('6.2')], angle: 'tips', slides: 8 },
            carousel: carouselFor('متجر إلكتروني كامل ببرومبت واحد', '#7C5CFF'),
            campaign: { keyword: 'متجر', variants: [], dm: DM, create: false },
            created_at: iso(-3 * MIN), updated_at: iso(-70 * 1000),
        }),
        renderedDraft('d-ready', { created_at: iso(-50 * MIN), updated_at: iso(-50 * MIN) }),
        renderedDraft('d-scheduled', {
            status: 'scheduled',
            carousel: carouselFor('خريطة الكورس في ٨ شرائح', '#22C55E'),
            schedule: { scheduled_time: slots[1], meta_row_id: 'r-1', tiktok: 'queue', tiktok_row_id: null, tiktok_public_done: false },
            created_at: iso(-26 * HOUR), updated_at: iso(-20 * HOUR),
        }),
        draftRow({
            id: 'd-failed', status: 'failed', input: { lessonIds: [], idea: 'أفضل ٥ أدوات مجانية للطلاب', angle: 'tips', slides: 8 },
            error: 'Gemini timed out after 120 seconds. Try again, or pick a lesson so it has notes to work from.',
            created_at: iso(-30 * HOUR), updated_at: iso(-30 * HOUR),
        }),
    ];
}

// ─── Scenarios ──────────────────────────────────────────────────────────────────────────
const WORKER_ONLINE = () => ({ online: true, lastSeen: iso(-5 * 1000), name: 'Studio Mac' });
const WORKER_OFFLINE = () => ({ online: false, lastSeen: iso(-3 * HOUR), name: 'Studio Mac' });
const WORKER_NEVER = () => ({ online: false, lastSeen: null, name: null });
const DEFAULT_ROOT = '/Users/you/Desktop/AI Course';

const SCENARIOS = {
    ready: { label: 'Everything working: worker online, library indexed, one draft in each status', build: () => ({}) },
    'first-run': {
        label: 'Brand-new tenant: no worker ever connected, no folder, nothing scanned, no drafts',
        build: () => ({ worker: WORKER_NEVER(), root: null, lessons: [], drafts: [], workers: [], tiktokQueued: 0 }),
    },
    offline: {
        label: 'Worker offline (last seen 3 hours ago), jobs waiting for it',
        build: () => ({ worker: WORKER_OFFLINE(), jobs: { pending: 3, claimed: 0 } }),
    },
    'no-folder': { label: 'Library folder not set', build: () => ({ root: null, lessons: [], drafts: [] }) },
    'not-scanned': { label: 'Folder set, library not scanned yet', build: () => ({ lessons: [], drafts: [] }) },
    indexing: {
        label: 'Library partly indexed: 12 of 34, 5 indexing, 1 failed',
        build: () => ({ lessons: buildLessons({ indexed: 12, indexing: 5, failed: 1 }), jobs: { pending: 4, claimed: 1 }, drafts: [] }),
    },
    'no-drafts': { label: 'Library indexed, no drafts yet', build: () => ({ drafts: [] }) },
    problems: { label: 'Saving a draft comes back with validation problems', build: () => ({ failPatch: true }) },
    audited: { label: 'TikTok has audited the app (TikTok posts at the same time)', build: () => ({ audited: true, tiktokQueued: 0 }) },
};

/** The in-memory world. `epoch` retires the timers of the previous scenario. */
let epoch = 0;
let state = null;

function buildState(name, opts = {}) {
    const key = Object.prototype.hasOwnProperty.call(SCENARIOS, name) ? name : 'ready';
    const o = SCENARIOS[key].build();
    const worker = o.worker || WORKER_ONLINE();
    epoch++;
    state = {
        name: key,
        epoch,
        worker,
        settings: settingsFixture(o.root === undefined ? DEFAULT_ROOT : o.root),
        lessons: o.lessons || buildLessons(),
        drafts: o.drafts || everyStatusDrafts(),
        jobs: o.jobs || { pending: 0, claimed: 0 },
        audited: !!o.audited,
        tiktokQueued: o.tiktokQueued === undefined ? 1 : o.tiktokQueued,
        workers: o.workers || [{ id: 'w-1', name: 'Studio Mac', last_seen_at: worker.lastSeen, created_at: iso(-12 * 24 * HOUR), revoked_at: null }],
        failPatch: !!o.failPatch,
        genMs: Math.max(0, Number(opts.gen ?? 8)) * 1000,
        renderMs: Math.max(1, Number(opts.render ?? 6)) * 1000,
    };
    // The `problems` scenario ships a draft that already breaks rules, so the live counters
    // show it before saving and PATCH answers with the real problem list.
    if (key === 'problems') {
        const d = state.drafts.find((x) => x.id === 'd-ready');
        d.carousel.slides[0].title = 'الدردشة ماتت… وبدأ عصر الوكيل الذكي الجديد';
        d.carousel.slides[4].items[1].text = 'قارن كل الموديلات والأسعار في كل المتاجر';
        d.carousel.captions.instagram = 'الدردشة ماتت 💬 وبدأ عصر الوكيل ⚡\n\n#الذكاء_الاصطناعي';
    }
    startBackground();
    return state;
}

// ─── Background: the worker and Gemini, simulated ────────────────────────────────────────
/** Run `fn` later unless a new scenario has replaced this one by then. */
function later(ms, fn) {
    const mine = epoch;
    setTimeout(() => { if (mine === epoch) fn(); }, ms);
}

const findDraft = (id) => state.drafts.find((d) => d.id === id) || null;

/** Queue a render. It is claimed and finished while the worker is online, and waits otherwise. */
function queueRender(draft) {
    draft.status = 'rendering';
    draft.error = null;
    draft.updated_at = iso();
    const job = `j-${draft.id}-${Date.now()}`;
    draft._job = job;
    state.jobs.pending += 1;
    if (!state.worker.online) return { id: job, kind: 'render_carousel', status: 'pending' };
    later(900, () => { state.jobs.pending = Math.max(0, state.jobs.pending - 1); state.jobs.claimed += 1; });
    later(state.renderMs, () => {
        state.jobs.claimed = Math.max(0, state.jobs.claimed - 1);
        const d = findDraft(draft.id);
        // An edit that arrived mid-render made this job stale (STUDIO.md §5): drop its result.
        if (!d || d.status !== 'rendering' || d._job !== job) return;
        const n = d.carousel && Array.isArray(d.carousel.slides) ? d.carousel.slides.length : 8;
        d.render = { ig: renderUrls('ig', n), tt: renderUrls('tt', n), rendered_at: iso(), job_id: job };
        d.status = 'ready';
        d.updated_at = iso();
    });
    return { id: job, kind: 'render_carousel', status: 'pending' };
}

/** The seeded busy drafts finish in their own time, as they would. */
function startBackground() {
    const rendering = findDraft('d-rendering');
    if (rendering && state.worker.online) {
        later(40 * 1000, () => {
            const d = findDraft('d-rendering');
            if (d && d.status === 'rendering') {
                d.render = { ig: renderUrls('ig', 8), tt: renderUrls('tt', 8), rendered_at: iso(), job_id: 'j-seed' };
                d.status = 'ready';
                d.updated_at = iso();
            }
        });
    }
    const writing = findDraft('d-generating');
    if (writing) {
        later(55 * 1000, () => {
            const d = findDraft('d-generating');
            if (!d || d.status !== 'generating') return;
            d.carousel = carouselFor('الذكاء الاصطناعي على جهازك', '#38BDF8');
            d.shots = shotsFor(d.carousel);
            d.campaign = { keyword: 'محلي', variants: [], dm: DM, create: true };
            queueRender(d);
        });
    }
}

// ─── Rules: a small port of validateCarousel, enough to produce its real messages ───────
const BUDGETS = {
    cover: { kicker: 24, title: 34, subtitle: 70 },
    point: { title: 40, body: 150, tip: 70 },
    list: { title: 36 },
    compare: { title: 36 },
    steps: { title: 36 },
    prompt: { title: 36, label: 20, prompt: 320, note: 70 },
    stat: { value: 8, label: 40, body: 120 },
    shot: { title: 40, caption: 90 },
    cta: { promise: 40 },
};

function validateCarousel(c) {
    const problems = [];
    const id = (c && c.id) || 'Carousel';
    const slides = c && Array.isArray(c.slides) ? c.slides : [];
    if (slides.length < 6 || slides.length > 10) problems.push(`${id}.slides: ${slides.length} items, expected 6–10`);
    if (slides[0] && slides[0].kind !== 'cover') problems.push(`${id}[1:${slides[0].kind}]: the first slide must be the cover`);
    const last = slides[slides.length - 1];
    if (last && last.kind !== 'cta') problems.push(`${id}[${slides.length}:${last.kind}]: the last slide must be the cta`);
    slides.forEach((s, i) => {
        const at = `${id}[${i + 1}:${s.kind}]`;
        const budgets = BUDGETS[s.kind] || {};
        for (const [field, max] of Object.entries(budgets)) {
            const value = typeof s[field] === 'string' ? s[field] : '';
            if (value.length > max) problems.push(`${at}.${field}: ${value.length} > ${max} «${value}»`);
        }
        if (['cover', 'point', 'list', 'steps', 'prompt', 'shot'].includes(s.kind) && !String(s.title || '').trim()) {
            problems.push(`${at}.title: required`);
        }
        if (s.kind === 'cover' && s.highlight && !String(s.title || '').includes(s.highlight)) {
            problems.push(`${at}.highlight «${s.highlight}» is not in the title`);
        }
        if (s.kind === 'list') {
            const items = Array.isArray(s.items) ? s.items : [];
            if (items.length < 3 || items.length > 5) problems.push(`${at}.items: ${items.length} items, expected 3–5`);
            items.forEach((item, k) => {
                const text = String((item && item.text) || '');
                if (text.length > 36) problems.push(`${at}.items[${k}].text: ${text.length} > 36 «${text}»`);
                const sub = String((item && item.sub) || '');
                if (sub.length > 60) problems.push(`${at}.items[${k}].sub: ${sub.length} > 60 «${sub}»`);
            });
        }
        if (s.kind === 'compare') {
            const left = (s.left && Array.isArray(s.left.items)) ? s.left.items : [];
            const right = (s.right && Array.isArray(s.right.items)) ? s.right.items : [];
            if (left.length !== right.length) problems.push(`${at}: compare sides differ in length`);
            [...left, ...right].forEach((text, k) => {
                if (String(text).length > 30) problems.push(`${at}.items[${k}]: ${String(text).length} > 30 «${text}»`);
            });
        }
    });
    const caps = (c && c.captions) || {};
    const title = String(caps.tiktokTitle || '');
    if (title.length > 90) problems.push(`${id}: tiktokTitle ${title.length} > 90 UTF-16`);
    const keyword = String((c && c.keyword) || '');
    if (!keyword || /\s/.test(keyword)) problems.push(`${id}: keyword must be one word`);
    const ask = state.settings.cta.instagramAsk.split('{keyword}').join(keyword);
    if (ask && !String(caps.instagram || '').includes(ask)) problems.push(`${id}: instagram caption doesn't contain the ask line «${ask}»`);
    const line = state.settings.cta.tiktokLine;
    if (line && !String(caps.tiktok || '').includes(line)) problems.push(`${id}: tiktok caption is missing the link-in-bio line «${line}»`);
    return problems;
}

// ─── Plan my week ───────────────────────────────────────────────────────────────────────
const PROPOSALS = [
    { no: '1.1', angle: 'compare', keyword: 'وكيل', title: 'الدردشة ماتت… وبدأ عصر الوكيل', rationale: 'أكثر فكرة يسأل عنها المتابعون، وتفتح الباب لبقية الكورس.' },
    { no: '6.2', angle: 'steps', keyword: 'متجر', title: 'متجر إلكتروني كامل ببرومبت واحد', rationale: 'نتيجة ملموسة يقدر أي أحد يجرّبها الليلة.' },
    { no: '2.1', angle: 'tips', title: '٥ استخدامات لـ NotebookLM ما توقعتها', rationale: 'منشورات النصائح هي الأكثر حفظاً عندك.' },
    { no: '8.1', angle: 'mistakes', title: 'ليش تشغّل الذكاء الاصطناعي على جهازك؟', rationale: 'الخصوصية موضوع متكرر في الرسائل.' },
    { no: '1.2', angle: 'prompt', title: 'هرم السياق: برومبت تنسخه وتعدّله', rationale: 'قالب جاهز يشجّع على كتابة الكلمة في التعليقات.' },
    { no: '9.1', angle: 'steps', title: 'سيرتك الذاتية في ٤ خطوات مع Opal', rationale: 'يوافق موسم التوظيف.' },
    { no: null, angle: 'overview', idea: 'وش بتتعلم في الكورس؟ خريطة سريعة', title: 'خريطة الكورس في ٨ شرائح', rationale: 'يعرّف المتابعين الجدد بالكورس كله.' },
];

function planProposals(count, lessonIds) {
    const slots = freeSlots(count, state.drafts.map((d) => d.schedule && d.schedule.scheduled_time).filter(Boolean));
    const picked = Array.isArray(lessonIds) && lessonIds.length ? lessonIds.map(String) : null;
    return PROPOSALS.slice(0, count).map((p, i) => {
        const ids = p.no ? [lessonId(p.no)] : [];
        const out = { lessonIds: picked && i === 0 ? picked : ids, angle: p.angle, slides: 8, title: p.title, rationale: p.rationale, slot: slots[i] || null };
        if (p.idea) out.idea = p.idea;
        if (p.keyword) out.keyword = p.keyword;
        return out;
    });
}

// ─── The operator API (STUDIO.md §4, §10.3) ─────────────────────────────────────────────
const ok = (body, status = 200) => ({ status, body });
const refuse = (status, error, problems) => ({ status, body: problems ? { error, problems } : { error } });

function statusBody() {
    if (state.worker.online) state.worker.lastSeen = iso(-4 * 1000);
    const count = (st) => state.lessons.filter((l) => l.status === st).length;
    const queued = state.drafts.filter((d) => d.schedule && d.schedule.tiktok === 'queue' && !d.schedule.tiktok_row_id).length;
    return {
        worker: { ...state.worker },
        lessons: { total: state.lessons.length, indexed: count('indexed'), indexing: count('indexing'), failed: count('failed') },
        jobs: { ...state.jobs },
        tiktok: { audited: state.audited, queued },
    };
}

const publicDraft = (d) => {
    const { _job, ...rest } = d;
    return clone(rest);
};

function draftLessons(d) {
    const ids = new Set([...(d.input && d.input.lessonIds) || [], ...Object.values(d.shots || {}).map((s) => s.lessonId)]);
    return state.lessons.filter((l) => ids.has(l.id)).map((l) => ({ id: l.id, lesson_no: l.lesson_no, title: l.title }));
}

/** Index lessons one after another while the worker is online, so progress bars move. */
function indexInTurn(ids) {
    if (!state.worker.online) { state.jobs.pending += ids.length; return; }
    ids.forEach((id, k) => later(1800 * (k + 1), () => {
        const lesson = state.lessons.find((l) => l.id === id);
        if (lesson && lesson.status === 'indexing') {
            lesson.status = 'indexed';
            lesson.indexed_at = iso();
        }
    }));
}

function resizeCarousel(c, n) {
    const cover = c.slides[0];
    const cta = c.slides[c.slides.length - 1];
    const middle = c.slides.slice(1, -1);
    while (middle.length > n - 2) middle.pop();
    let extra = 3;
    while (middle.length < n - 2) middle.push({ kind: 'point', n: extra++, title: 'راجع النتيجة قبل ما تعتمدها', body: 'الوكيل يسلّمك شغل جاهز، وأنت تقرّر إذا يمشي أو يحتاج تعديل.' });
    c.slides = [cover, ...middle, cta];
    return c;
}

async function studioApi(method, parts, query, body) {
    const [head, id, sub] = parts;
    const b = body && typeof body === 'object' ? body : {};

    if (method === 'GET' && head === 'status') return ok(statusBody());

    // Settings and workers
    if (head === 'settings') {
        if (method === 'GET') return ok({ settings: clone(state.settings) });
        if (method === 'PUT') {
            const problems = [];
            const next = clone(state.settings);
            for (const key of ['brand', 'voice', 'product', 'cta', 'schedule', 'library']) {
                if (b[key] && typeof b[key] === 'object') next[key] = { ...next[key], ...b[key] };
            }
            // The server's own wording (src/services/studio/settings.ts): each message leads with its path.
            (next.brand.palette || []).forEach((c, k) => { if (!/^#[0-9A-F]{6}$/i.test(c)) problems.push(`brand.palette[${k}] must be a colour like #FFD60A`); });
            if (!next.brand.palette.length) problems.push('brand.palette needs at least one colour');
            if (next.product.url && !/^https:\/\//i.test(next.product.url)) problems.push('product.url must be a web address starting with https://');
            (next.schedule.slots || []).forEach((s, k) => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) problems.push(`schedule.slots[${k}] must be a time like 13:00`); });
            if (!(next.schedule.slots || []).length) problems.push('schedule.slots needs at least one time');
            if (next.cta.instagramAsk && !next.cta.instagramAsk.includes('{keyword}')) problems.push('cta.instagramAsk must contain {keyword}: it is what the comment automation answers');
            if (next.library.root && !String(next.library.root).startsWith('/')) problems.push('library.root must be a full folder path, e.g. /Users/you/Videos/Course');
            if (problems.length) return refuse(400, 'Some settings need fixing.', problems);
            state.settings = next;
            return ok({ settings: clone(state.settings) });
        }
    }
    if (head === 'workers') {
        if (method === 'GET' && !id) return ok({ workers: clone(state.workers) });
        if (method === 'POST' && !id) {
            const name = String(b.name || '').trim();
            if (!name) return refuse(400, 'Give the worker a name.');
            const worker = { id: `w-${Date.now()}`, name, last_seen_at: null, created_at: iso(), revoked_at: null };
            state.workers.unshift(worker);
            const token = `stw_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
            return ok({ worker: clone(worker), token }, 201);
        }
        if (method === 'DELETE' && id) {
            const w = state.workers.find((x) => x.id === id);
            if (!w) return refuse(404, 'No such worker.');
            w.revoked_at = iso();
            return ok(null, 204);
        }
    }

    // Library
    if (head === 'lessons') {
        if (method === 'GET' && !id) {
            return ok({
                lessons: state.lessons.map((l) => ({
                    ...l, summary: l.status === 'indexed' ? lessonNotes().summary : null, moments_count: l.status === 'indexed' ? MOMENT_TEXT.length : 0,
                })),
            });
        }
        if (method === 'POST' && id === 'index-missing') {
            const missing = state.lessons.filter((l) => l.status === 'new' || l.status === 'failed');
            missing.forEach((l) => { l.status = 'indexing'; l.error = null; });
            indexInTurn(missing.map((l) => l.id));
            return ok({ count: missing.length });
        }
        const lesson = state.lessons.find((l) => l.id === id);
        if (!lesson) return refuse(404, 'No such lesson.');
        if (method === 'GET') {
            const indexed = lesson.status === 'indexed';
            return ok({ lesson: { ...lesson, notes: indexed ? lessonNotes() : null }, moments: indexed ? buildMoments(lesson) : [] });
        }
        if (method === 'POST' && sub === 'index') {
            lesson.status = 'indexing';
            lesson.error = null;
            indexInTurn([lesson.id]);
            return ok({ job: { id: `j-index-${lesson.id}`, kind: 'index_lesson', status: 'pending' } });
        }
    }
    if (method === 'POST' && head === 'scan') {
        if (!state.settings.library.root) return refuse(400, 'Set your library folder first.');
        const job = { id: `j-scan-${Date.now()}`, kind: 'scan_library', status: 'pending' };
        if (!state.worker.online) { state.jobs.pending += 1; return ok({ job }); }
        later(2500, () => { if (!state.lessons.length) state.lessons = buildLessons({ indexed: 0 }); });
        return ok({ job });
    }

    // Drafts
    if (head === 'drafts' && !id) {
        if (method === 'GET') {
            const list = state.drafts.slice().sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at));
            return ok({ drafts: list.map(publicDraft) });
        }
        if (method === 'POST') {
            const lessonIds = Array.isArray(b.lessonIds) ? b.lessonIds.map(String) : [];
            const idea = typeof b.idea === 'string' ? b.idea.trim() : '';
            const problems = [];
            if (!lessonIds.length && !idea) problems.push('idea is required when lessonIds is empty');
            if (b.keyword && /\s/.test(String(b.keyword))) problems.push('keyword must be one word');
            if (b.accent && !/^#[0-9A-F]{6}$/i.test(String(b.accent))) problems.push('accent must be #RRGGBB');
            if (problems.length) return refuse(400, 'Invalid input', problems);
            const draft = draftRow({
                id: `d-${Date.now().toString(36)}`, status: 'generating',
                input: { lessonIds, ...(idea ? { idea } : {}), angle: b.angle || 'auto', slides: Number(b.slides) || 8, ...(b.keyword ? { keyword: b.keyword } : {}), ...(b.accent ? { accent: b.accent } : {}) },
                created_at: iso(), updated_at: iso(),
            });
            state.drafts.unshift(draft);
            const mine = epoch;
            await sleep(state.genMs);
            if (mine !== epoch) return ok({ draft: publicDraft(draft) }, 201);
            if (/fail/i.test(idea)) {
                draft.status = 'failed';
                draft.error = 'Gemini timed out after 120 seconds. Try again.';
                draft.updated_at = iso();
                return ok({ draft: publicDraft(draft) }, 201);
            }
            const palette = state.settings.brand.palette;
            const carousel = resizeCarousel(carouselFor(idea || null, b.accent || palette[(state.drafts.length) % palette.length]), Math.min(10, Math.max(6, Number(b.slides) || 8)));
            if (b.keyword) carousel.keyword = String(b.keyword);
            draft.carousel = carousel;
            draft.shots = shotsFor(carousel);
            draft.campaign = { keyword: carousel.keyword, variants: [], dm: DM, create: true };
            queueRender(draft);
            return ok({ draft: publicDraft(draft) }, 201);
        }
    }
    if (head === 'drafts' && id) {
        const d = findDraft(id);
        if (!d) return refuse(404, 'No such draft.');
        if (method === 'GET' && !sub) return ok({ draft: publicDraft(d), lessons: draftLessons(d) });
        const locked = d.status === 'scheduled'
            ? refuse(409, 'This draft is scheduled, so it can no longer be changed. Its posts are in Posts.')
            : d.status === 'generating' ? refuse(409, 'This draft is still being written. Wait for it to finish.') : null;
        if (method === 'PATCH' && !sub) {
            if (locked) return locked;
            const carousel = b.carousel || d.carousel;
            const problems = validateCarousel(carousel);
            if (problems.length) return refuse(400, `The carousel breaks ${problems.length} rule${problems.length === 1 ? '' : 's'}.`, problems);
            d.carousel = clone(carousel);
            if (b.shots) d.shots = clone(b.shots);
            if (b.campaign) d.campaign = clone(b.campaign);
            queueRender(d);
            return ok({ draft: publicDraft(d) });
        }
        if (method === 'DELETE' && !sub) {
            if (d.status === 'scheduled') return locked;
            state.drafts = state.drafts.filter((x) => x.id !== id);
            return ok(null, 204);
        }
        if (method === 'POST' && sub === 'rewrite') {
            if (locked) return locked;
            const index = Number(b.index);
            const slide = d.carousel && d.carousel.slides[index];
            if (!slide) return refuse(400, 'No such slide.');
            await sleep(2500);
            if (typeof slide.title === 'string') slide.title = index === 0 ? 'خلّ الذكاء الاصطناعي يشتغل عنك' : 'اعطه هدف… وخلّه ينفّذ';
            if (typeof slide.body === 'string') slide.body = 'بدل ما تسأله سؤال، قل له وش النتيجة اللي تبيها، وخلّه يرتّب الطريق بنفسه.';
            queueRender(d);
            return ok({ draft: publicDraft(d) });
        }
        if (method === 'POST' && sub === 'render') {
            if (locked) return locked;
            return ok({ job: queueRender(d) });
        }
        if (method === 'POST' && sub === 'schedule') {
            if (d.status !== 'ready') return refuse(409, 'Only a ready draft can be scheduled.');
            const when = Date.parse(String(b.scheduled_time || ''));
            if (!Number.isFinite(when) || when <= Date.now()) return refuse(400, 'Pick a time in the future.');
            const tiktok = ['none', 'queue', 'scheduled'].includes(b.tiktok) ? b.tiktok : 'none';
            if (tiktok === 'scheduled' && !state.audited) return refuse(400, 'TikTok has not approved the app yet, so a TikTok post cannot be scheduled.');
            d.status = 'scheduled';
            d.schedule = { scheduled_time: new Date(when).toISOString(), meta_row_id: `r-${d.id}`, tiktok, tiktok_row_id: tiktok === 'scheduled' ? `r-tt-${d.id}` : null, tiktok_public_done: false };
            d.updated_at = iso();
            const rows = [{ id: `r-${d.id}`, platform: 'both', post_type: 'carousel' }];
            if (tiktok === 'scheduled') rows.push({ id: `r-tt-${d.id}`, platform: 'tiktok', post_type: 'carousel' });
            return ok({ draft: publicDraft(d), rows });
        }
        if (method === 'POST' && sub === 'tiktok-public') {
            d.schedule = { ...(d.schedule || {}), tiktok_public_done: b.done === true };
            return ok({ draft: publicDraft(d) });
        }
    }
    if (method === 'POST' && head === 'tiktok' && id === 'batch') {
        let queued = 0;
        state.drafts.forEach((d) => {
            if (d.schedule && d.schedule.tiktok === 'queue' && !d.schedule.tiktok_row_id) {
                d.schedule.tiktok_row_id = `r-tt-${d.id}`;
                queued++;
            }
        });
        return ok({ queued });
    }
    if (method === 'GET' && head === 'slots') {
        const count = Math.min(20, Math.max(1, Number(query.get('count')) || 6));
        return ok({ slots: freeSlots(count, state.drafts.map((d) => d.schedule && d.schedule.scheduled_time).filter(Boolean)) });
    }
    if (method === 'POST' && head === 'plan') {
        await sleep(1800);
        const count = Math.min(7, Math.max(1, Number(b.count) || 5));
        return ok({ proposals: planProposals(count, b.lessonIds) });
    }
    return refuse(404, `No such Studio route: ${method} /api/studio/${parts.join('/')}`);
}

// ─── HTTP ───────────────────────────────────────────────────────────────────────────────
const SESSION = {
    userId: 'u-harness', role: 'platform_admin', tenantId: 't-harness', tenantRole: 'owner',
    tenants: [{ id: 't-harness', name: 'Agentic AI بالعربي', role: 'owner' }],
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    if (status === 204 || body === null || body === undefined) { res.end(); return; }
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
}

async function sendFile(res, file) {
    try {
        const info = await stat(file);
        if (!info.isFile()) return send(res, 404, { error: 'Not found.' });
        send(res, 200, await readFile(file), TYPES[extname(file).toLowerCase()] || 'application/octet-stream');
    } catch {
        send(res, 404, { error: 'Not found.' });
    }
}

/** `/api/uploads/ig-01.jpg` → the real IG render, `tt-…` the TikTok one, `shot-…` a lesson frame. */
function uploadPath(name) {
    if (!/^[\w.-]+$/.test(name)) return null;
    if (name.startsWith('ig-')) return join(RENDERS, 'ig', name.slice(3));
    if (name.startsWith('tt-')) return join(RENDERS, 'tt', name.slice(3));
    if (name.startsWith('shot-')) return join(SHOTS, name.slice(5));
    return null;
}

/**
 * The dashboard shell with a seed script at the very top of <head>: it runs before the
 * inline theme/lang snippet and before api.js reads `auth_token`.
 */
async function shell(res, seed) {
    const index = await readFile(join(DASHBOARD, 'index.html'), 'utf8');
    const json = JSON.stringify(seed).replace(/</g, '\\u003c');
    const script = `<script>(function (seed) {
    try {
        localStorage.setItem('auth_token', 'harness-session');
        if (seed.lang) localStorage.setItem('dashboard_lang', seed.lang);
        if (seed.theme) localStorage.setItem('dashboard_theme', seed.theme);
        else if (seed.reset) localStorage.removeItem('dashboard_theme');
        if (seed.reset) Object.keys(localStorage).filter(function (k) { return k.indexOf('studio:') === 0; })
            .forEach(function (k) { localStorage.removeItem(k); });
        if (seed.to) history.replaceState(null, '', '/dashboard/#' + seed.to);
    } catch (e) { /* private mode: the login screen shows instead */ }
}(${json}));</script>`;
    send(res, 200, index.replace('<head>', `<head>\n${script}`), TYPES['.html']);
}

/** The Help Center views worth opening by hand: the front page, an article, a section, a miss. */
const HELP_LINKS = [
    ['All articles', '/help'],
    ['What is the worker?', '/help/worker'],
    ['Worker → Security (deep link)', '/help/worker#security'],
    ['TikTok → Until TikTok approves the app', '/help/tiktok#before-approval'],
    ['Troubleshooting', '/help/troubleshooting'],
    ['An article that does not exist', '/help/no-such-article'],
];

function indexPage() {
    const row = (key, s) => `
        <tr><th scope="row"><code>${key}</code></th><td>${s.label}</td>
        <td><a href="/harness?s=${key}&lang=en">English</a></td>
        <td><a href="/harness?s=${key}&lang=ar">العربية</a></td>
        <td><a href="/harness?s=${key}&lang=en&to=/studio?draft=d-ready">editor</a></td></tr>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Studio harness</title>
<style>
    :root { color-scheme: light dark; --ink: #1d1d1f; --paper: #f5f5f7; --line: rgba(0,0,0,.12); --link: #0040dd; }
    @media (prefers-color-scheme: dark) { :root { --ink: #f5f5f7; --paper: #161617; --line: rgba(255,255,255,.14); --link: #6bb1ff; } }
    body { margin: 0; padding: 24px 16px; font: 15px/1.5 -apple-system, system-ui, sans-serif; color: var(--ink); background: var(--paper); }
    main { max-width: 960px; margin: 0 auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: start; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
    a { color: var(--link); }
    code { font-size: 13px; }
    .wrap { overflow-x: auto; }
</style></head><body><main>
<h1>Carousel Studio harness</h1>
<p>Each link resets the in-memory API to that scenario and opens <code>#/studio</code> with a seeded session.
Add <code>&amp;gen=30</code> for a slower generation, <code>&amp;render=20</code> for a slower render,
<code>&amp;theme=light</code> or <code>dark</code>, and an idea containing “fail” to see a failed generation.</p>
<div class="wrap"><table><thead><tr><th>Scenario</th><th>What it shows</th><th colspan="3">Open</th></tr></thead>
<tbody>${Object.entries(SCENARIOS).map(([k, s]) => row(k, s)).join('')}</tbody></table></div>
<p>Images: ${IG_FILES.length} Instagram and ${TT_FILES.length} TikTok renders, ${SHOT_FILES.length} lesson frames.</p>
<h2>Help Center</h2>
<p>The articles are static (<code>dashboard/js/help-content.js</code>), so any scenario serves them. Deep links put the
section after a second <code>#</code>, written <code>%23</code> inside <code>to=</code>.</p>
<div class="wrap"><table><thead><tr><th>Page</th><th colspan="2">Open</th></tr></thead><tbody>${HELP_LINKS.map(([label, to]) => `
    <tr><th scope="row">${label}</th>
    <td><a href="/harness?s=ready&lang=en&to=${encodeURIComponent(to)}">English</a></td>
    <td><a href="/harness?s=ready&lang=ar&to=${encodeURIComponent(to)}">العربية</a></td></tr>`).join('')}</tbody></table></div>
</main></body></html>`;
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = decodeURIComponent(url.pathname);
    const method = req.method || 'GET';
    try {
        if (path === '/' || path === '/index.html') return send(res, 200, indexPage(), TYPES['.html']);
        if (path === '/harness') {
            buildState(url.searchParams.get('s') || 'ready', { gen: url.searchParams.get('gen') ?? undefined, render: url.searchParams.get('render') ?? undefined });
            const lang = ['ar', 'en'].includes(url.searchParams.get('lang')) ? url.searchParams.get('lang') : '';
            const theme = ['light', 'dark'].includes(url.searchParams.get('theme')) ? url.searchParams.get('theme') : '';
            const to = url.searchParams.get('to') || '/studio';
            return shell(res, { lang, theme, to: to.startsWith('/') ? to : `/${to}`, reset: url.searchParams.get('keep') !== '1' });
        }
        if (path === '/dashboard' || path === '/dashboard/' || path === '/dashboard/index.html') return shell(res, {});

        if (path.startsWith('/api/')) {
            const parts = path.slice(5).split('/').filter(Boolean);
            if (parts[0] === 'uploads' && parts[1]) {
                const file = uploadPath(parts[1]);
                return file && existsSync(file) ? sendFile(res, file) : send(res, 404, { error: 'No such upload.' });
            }
            if (parts[0] === 'auth' && parts[1] === 'me') return send(res, 200, SESSION);
            if (parts[0] === 'studio') {
                const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readJson(req) : {};
                const out = await studioApi(method, parts.slice(1), url.searchParams, body);
                console.log(`${method} ${path} → ${out.status}`);
                return send(res, out.status, out.body);
            }
            // Everything else the shell might ask for: an empty, successful answer.
            return send(res, 200, method === 'GET' ? {} : { ok: true });
        }

        if (path.startsWith('/dashboard/')) {
            const file = normalize(join(DASHBOARD, path.slice('/dashboard/'.length)));
            if (!file.startsWith(DASHBOARD + sep)) return send(res, 403, { error: 'Outside the dashboard.' });
            return sendFile(res, file);
        }
        return send(res, 404, { error: 'Not found.' });
    } catch (err) {
        console.error(err);
        return send(res, 500, { error: (err && err.message) || 'Harness error.' });
    }
});

buildState('ready');
server.listen(PORT, () => {
    console.log(`Studio harness on http://localhost:${PORT}/  (${IG_FILES.length} IG + ${TT_FILES.length} TT renders, ${SHOT_FILES.length} frames)`);
});
