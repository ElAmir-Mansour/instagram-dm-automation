/**
 * The prompt surface: every prompt builder the golden tests pin, called the one way, in one place.
 *
 * Two things read this file and nothing else decides what a builder is handed:
 *
 *   - `golden.test.ts` writes each entry into a golden file and compares the bytes (docs/onboarding/05 §3);
 *   - `scripts/prompt-parity.mts` hashes each entry for a LIVE tenant, once from the settings as stored
 *     (path (a)) and once through the profile (path (b)), and fails when they differ (05 §4).
 *
 * Had the script a copy of the test's builder calls, the two would drift the first time a builder gained an
 * argument: the goldens would pass on one set of calls and the live check would hash another. So there is no
 * second copy. A builder added to the goldens is added here, and the parity script covers it from the same commit.
 *
 * Only what depends on a tenant's settings lives here: the schemas, the language kits and the other constants
 * are the same bytes on both paths, and their goldens stay in `golden.test.ts`.
 *
 * Each function returns entries named as their golden files are: `studio.system.elamir` is
 * `__golden__/<set>/studio.system.elamir.txt`. A `slug` is that suffix; the parity script passes none, so its
 * rows read `studio.system`.
 *
 * Nothing here touches the database. The two Growth builders read it, so they run against a stand-in for the pool
 * (`withRows`) that answers from the rows they are handed and gives every other query nothing, then puts the pool back.
 *
 * A builder that throws does not end the surface: its entry carries `error` instead of a value, so the golden test fails
 * that one entry by name and the parity script reports it (and exits 2) while every other builder is still compared.
 *
 * Test fixtures are imported (the writer's lessons, transcript lines, reels): they are the *turn* both paths are
 * fed, the same on each, and not tenant data. Production code never imports this file.
 */
import { pool } from '../../config/db.js';
import type { ClipDirection, GrowthSettings } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { dmFallbackReply } from '../../webhook/errors.js';
import { disclosureLine } from '../../webhook/meta-payload.js';
import { dmResponseSchema, dmSystemInstruction, type DmContext, starterPersona } from '../ai.js';
import { buildSalesPrompt } from '../dmSales/prompt.js';
import { salesReplySchema } from '../dmSales/schema.js';
import type { SalesFacts } from '../dmSales/types.js';
import { coachSystemPrompt, runCoach } from '../growth/coach.js';
import { keywordsSystemPrompt, suggestKeywords } from '../growth/keywords.js';
import { analystSystemPrompt } from '../monteur/analyst.js';
import { copySystemPrompt, copyUserPrompt, toClipCopy, type CopyContext } from '../monteur/copy.js';
import { reelKitsFromContexts, type ReelKits } from '../monteur/copyKits.js';
import { editorSystemPrompt } from '../monteur/editor.js';
import { editorKit } from '../monteur/editorKits.js';
import { pickSystemPrompt, pickUserPrompt } from '../monteur/pick.js';
import { buildRenderPayload } from '../monteur/render.js';
import type { Carousel } from '../studio/carouselTypes.js';
import { renderPayload as carouselRenderPayload } from '../studio/drafts.js';
import { normalizeInstagramCaption, normalizeTiktokCaption, type CallModel, type ModelRequest } from '../studio/generate.js';
import { payloadBrand, type InfographicWriterContext } from '../studio/infographicSpec.js';
import { renderPayload as infographicRenderPayload } from '../studio/infographics.js';
import {
    askLine, buildCatalog, buildDm, buildPlanSystemPrompt, buildSystemPrompt, draftUserPrompt, type StudioWording, saveLine, tiktokLine, writerKit,
} from '../studio/prompts.js';
import type { StudioSettings } from '../studio/settingsTypes.js';
import {
    ELAMIR_SEO, GOLDEN_CLIPS, GOLDEN_LESSON, GOLDEN_LESSONS, GOLDEN_LINES, GOLDEN_REEL_EVIDENCE, GOLDEN_SOURCES,
} from '../studio/testFixtures.js';
import { contextFor, type ProfileContext } from './context.js';
import { describeFailure } from './failure.js';
import { goldenJsonText, type GoldenSet } from './golden.js';
import { profileFromLegacy } from './legacy.js';
import type { CreatorProfile } from './types.js';

/** One builder's output: what a golden file holds, and what the parity script hashes. */
export interface SurfaceEntry {
    /** The golden file's name, without its extension. */
    name: string;
    /** `text` is a prompt, compared as it is; `json` is a payload, compared as `goldenJsonText` writes it. */
    kind: 'text' | 'json';
    /** Where the golden lives. The parity script ignores it. */
    set: GoldenSet;
    /** The text, or the value to serialise. `undefined` when the builder threw. */
    value: unknown;
    /** Set when the builder threw: what it threw, as `describeFailure` prints it. */
    error?: string;
}

export type SurfaceLang = 'ar' | 'en';

/** The bytes a golden file holds for this entry: the thing that is compared, and that the parity script hashes. */
export function entryText(entry: Pick<SurfaceEntry, 'kind' | 'value'> & Partial<Pick<SurfaceEntry, 'name' | 'error'>>): string {
    if (entry.error !== undefined) throw new Error(`${entry.name ?? 'an entry'} was not built: ${entry.error}`);
    if (entry.kind === 'text') {
        if (typeof entry.value !== 'string') throw new Error('a text entry must hold a string');
        return entry.value;
    }
    return goldenJsonText(entry.value);
}

/** `base` and the fixture's suffix: `studio.system` and `elamir` are `studio.system.elamir`. */
const named = (base: string, slug: string | undefined): string => (slug ? `${base}.${slug}` : base);

const text = (name: string, set: GoldenSet, value: string): SurfaceEntry => ({ name, kind: 'text', set, value });

/**
 * The pick and the Marketer's kits for a profile: the contexts its two purposes are given, and the kits those select (P11). The
 * owner's, here, is what `profileFromLegacy` makes of his rows (path (a)) or what his stored profile says (path (b)), and the
 * sweep reads the same contexts of the same profile (`reelKitsFor`), so the prompts below are built the way production builds them.
 */
export const reelKitsOf = (profile: CreatorProfile): ReelKits =>
    reelKitsFromContexts(contextFor(profile, 'clip_pick', null), contextFor(profile, 'clip_copy', null));

/** One builder, called: its output, or what it threw. One builder that fails must not hide the rest of the surface. */
function built(name: string, kind: 'text' | 'json', set: GoldenSet, build: () => unknown): SurfaceEntry {
    try {
        return { name, kind, set, value: build() };
    } catch (err) {
        return { name, kind, set, value: undefined, error: describeFailure(err) };
    }
}

async function builtAsync(name: string, kind: 'text' | 'json', set: GoldenSet, build: () => Promise<unknown>): Promise<SurfaceEntry> {
    try {
        return { name, kind, set, value: await build() };
    } catch (err) {
        return { name, kind, set, value: undefined, error: describeFailure(err) };
    }
}

/** A value several entries share, made on first use. If making it throws, each entry that needs it reports that failure. */
function lazy<T>(make: () => T): () => T {
    let state: { value: T } | { error: unknown } | undefined;
    return () => {
        if (!state) {
            try {
                state = { value: make() };
            } catch (error) {
                state = { error };
            }
        }
        if ('error' in state) throw state.error;
        return state.value;
    };
}

/** The story the Studio's and the Monteur's builders are fed, in one language: a topic, recent posts, a caption, a reel's copy. */
export interface Say {
    idea: string;
    recent: readonly string[];
    recentAsk: string;
    question: string;
    pitch: string;
    keyword: string;
    candidates: readonly string[];
    igCaption: string;
    ttCaption: string;
    copy: {
        first_line: string;
        body: string;
        tiktok_body: string;
        hashtags: readonly string[];
        keyword_candidates: readonly string[];
        variants: readonly string[];
        alt_text: string;
    };
}

/**
 * What a turn is made of: the story, the words of the creator's active campaigns, and the search keywords and hashtags the Growth
 * settings hand the writer. A tenant's own come from its rows and its posts (empty, for a new one); these stand in for them.
 */
export interface SurfaceTurn {
    say: Say;
    activeKeywords: readonly string[];
    seo: { keywords: string[]; hashtags: string[] };
}

/** The same story in each language, so the English control is fed English. It is the OWNER's: his topics, his captions, his tags. */
export const SAY: Record<SurfaceLang, Say> = {
    ar: {
        idea: 'ملفاتك السرية تشتغل على جهازك',
        recent: ['الدردشة ماتت… وبدأ عصر الوكيل', 'سياق الذكاء الاصطناعي في ٥ طبقات'],
        recentAsk: 'حاب تطبقها بنفسك؟ علّق «{keyword}» وأرسل لك التفاصيل 📩',
        question: 'تبي ذكاء اصطناعي شغّال على جهازك؟ 🔒',
        pitch: 'في قسم الذكاء المحلي أشرح لك كيف تشغّله خطوة بخطوة.',
        keyword: 'محلي',
        candidates: ['محلي', 'سياق'],
        igCaption: 'ملفاتك السرية… ما تطلع من جهازك 🔒\n\n🔒 نموذج يشتغل بدون نت\n⚡ يجاوب من ملفاتك أنت\n\nاسحب وخذ البرومبت 👈\n\n#ذكاء_اصطناعي #LMStudio #AI',
        ttCaption: 'اكتب "محلي" بالتعليقات ويوصلك رابط الكورس بالخاص 📩\n\nملفاتك السرية… ما تطلع من جهازك 🔒\n\nنموذج يشتغل بدون نت ويجاوب من ملفاتك\n\n#ذكاء_اصطناعي #LMStudio #AI',
        copy: {
            first_line: 'ملفاتك السرية ما تطلع من جهازك',
            body: 'نموذج يشتغل بدون نت ويجاوب من ملفاتك\nابعتها لصاحبك اللي يخاف على ملفاته',
            tiktok_body: 'شرح خطوة بخطوة لتشغيل نموذج محلي على جهازك، ورابطه في البايو.',
            hashtags: ['ذكاء_اصطناعي', 'LMStudio', 'تقنية'],
            keyword_candidates: ['محلي', 'خصوصية', 'ملفات'],
            variants: ['مَحلي'],
            alt_text: 'متحدث يشرح كيف يعمل نموذج ذكاء اصطناعي بدون إنترنت',
        },
    },
    en: {
        idea: 'Run a private AI on your own laptop',
        recent: ['Stop asking AI questions. Give it a goal', 'Context in five layers'],
        recentAsk: 'Want to try it yourself? Comment «{keyword}» 👇',
        question: 'Want an AI that runs on your own laptop? 🔒',
        pitch: 'The local-AI section shows you how, step by step.',
        keyword: 'local',
        candidates: ['local', 'context'],
        igCaption: 'Your private files never leave your laptop 🔒\n\n🔒 A model that runs offline\n⚡ Answers from your own files\n\nSwipe and grab the prompt 👉\n\n#AI #LMStudio',
        ttCaption: 'Comment "local" and I\'ll DM you the link 📩\n\nYour private files never leave your laptop 🔒\n\nA model that runs offline and answers from your files\n\n#AI #LMStudio',
        copy: {
            first_line: 'Your private files never leave your laptop',
            body: 'A model that runs offline and answers from your own files\nSend this to the friend who worries about their files',
            tiktok_body: 'A step by step guide to running a local model on your laptop, and the link is in bio.',
            hashtags: ['AI', 'LMStudio', 'tech'],
            keyword_candidates: ['local', 'privacy', 'offline'],
            variants: ['locall'],
            alt_text: 'A speaker explains how an AI model runs without the internet',
        },
    },
};

/** The turn the owner's goldens and the live parity check are fed: his story and his search words. */
export const OWNER_TURN = (lang: SurfaceLang): SurfaceTurn => ({ say: SAY[lang], activeKeywords: ['وكيل', 'سياق'], seo: ELAMIR_SEO });

/**
 * A story that is nobody's: a week plan, in each language. What a test feeds the builders to see what THEY say for a tenant, so that
 * nothing of the owner's reaches the text through the turn (his captions, his recent posts, his hashtags are in `SAY` and `ELAMIR_SEO`).
 * No time word, no Gulf word, no course.
 */
export const NEUTRAL_SAY: Record<SurfaceLang, Say> = {
    ar: {
        idea: 'ثلاث خطوات لتنظيم أسبوعك',
        recent: ['خمس عادات صغيرة لصباح أهدأ', 'كيف تبدأ بخطوة واحدة'],
        recentAsk: 'هل تودّ تجربتها؟ اكتب «{keyword}» في التعليقات 👇',
        question: 'هل تريد تنظيم أسبوعك بخطوات بسيطة؟ 👀',
        pitch: 'نشرح لك كل خطوة بالتفصيل.',
        keyword: 'تنظيم',
        candidates: ['تنظيم', 'أسبوع'],
        igCaption: 'ثلاث خطوات تنظّم أسبوعك ✨\n\n📝 اكتب مهامك\n⏱️ وزّعها على الأيام\n\nاسحب للمزيد 👈\n\n#تنظيم #عادات',
        ttCaption: 'اكتب "تنظيم" في التعليقات ويصلك الرابط في الخاص 📩\n\nثلاث خطوات تنظّم أسبوعك ✨\n\n#تنظيم #عادات',
        copy: {
            first_line: 'ثلاث خطوات تنظّم أسبوعك',
            body: 'اكتب مهامك ثم وزّعها على الأيام\nأرسلها لصديق يحتاجها',
            tiktok_body: 'ثلاث خطوات بسيطة لتنظيم الأسبوع، والرابط في البايو.',
            hashtags: ['تنظيم', 'عادات', 'إنتاجية'],
            keyword_candidates: ['تنظيم', 'أسبوع', 'مهام'],
            variants: ['تنظيمم'],
            alt_text: 'متحدث يشرح ثلاث خطوات لتنظيم الأسبوع',
        },
    },
    en: {
        idea: 'Three steps to plan your week',
        recent: ['Five small habits for a calmer morning', 'Start with one step'],
        recentAsk: 'Want to try it yourself? Comment «{keyword}» 👇',
        question: 'Want to plan your week in three simple steps? 👀',
        pitch: 'Every step is explained one by one.',
        keyword: 'plan',
        candidates: ['plan', 'week'],
        igCaption: 'Three steps to plan your week ✨\n\n📝 Write your tasks\n⏱️ Spread them over the days\n\nSwipe for more 👉\n\n#planning #habits',
        ttCaption: 'Comment "plan" and I\'ll DM you the link 📩\n\nThree steps to plan your week ✨\n\n#planning #habits',
        copy: {
            first_line: 'Three steps to plan your week',
            body: 'Write your tasks, then spread them over the days\nSend this to a friend who needs it',
            tiktok_body: 'Three simple steps to plan your week, and the link is in bio.',
            hashtags: ['planning', 'habits', 'productivity'],
            keyword_candidates: ['plan', 'week', 'tasks'],
            variants: ['plann'],
            alt_text: 'A speaker explains three steps to plan the week',
        },
    },
};

/** The neutral turn for a tenant: `NEUTRAL_SAY` in its language, and search words of no one's. */
export const NEUTRAL_TURN = (lang: SurfaceLang): SurfaceTurn => ({
    say: NEUTRAL_SAY[lang],
    activeKeywords: lang === 'ar' ? ['خطة', 'مهام'] : ['routine', 'tasks'],
    seo: { keywords: ['planning', 'habits'], hashtags: ['#planning', '#habits'] },
});

/** A direction the Editor plans, fed to the render payload. */
const PLAN: ClipDirection = {
    cuts: [{ t: 2.5, shot: 'close' }, { t: 8, shot: 'wide' }],
    doodles: [{ t: 3.1, shape: 'arrow', target: 'head' }],
    freezes: [{ t: 9.4, text: 'استنى' }],
    transitions: [{ t: 12, kind: 'glitch' }],
    behind: [{ t: 5, text: 'عشرة أضعاف' }],
    emphasis: [2.5, 6.25],
};

// ─── The Studio writer and the Monteur ──────────────────────────────────────────────────────

export interface StudioSurfaceOptions {
    /** The language the story the builders are fed is told in: the tenant's own (`settings.voice.language`). */
    lang: SurfaceLang;
    /**
     * The story the builders are fed (`OWNER_TURN`, the default: the one every golden and the live parity check were captured with).
     * A test that asks what the BUILDERS say for a tenant hands `NEUTRAL_TURN`, so nothing of the owner's can come in through it.
     */
    turn?: (lang: SurfaceLang) => SurfaceTurn;
    /**
     * What the Studio's writer is told about the creator (P9): the `carousel` context of the profile the caller reads the tenant
     * through (`studioWording`). Handed to the builders exactly as `generateDraft` hands it. No default: a path that forgot to give one fails to compile instead of quietly writing the owner's text.
     * It may be a function that makes it (`Wording`), so a tenant whose profile cannot be made into one fails those entries by name.
     */
    carousel: Wording<StudioWording>;
    /** The fixture's suffix in the golden names (`elamir`, `seed`, `english`). None for a live tenant. */
    slug?: string;
    /** The golden set these belong to. */
    set?: GoldenSet;
    /**
     * The profile context the Editor's prompt is written from (P10: `editorKit(ctx)`), or a function that makes it (so a tenant whose
     * profile cannot be described fails the Editor's entries by name, not the whole surface). Without one it is the context of the
     * profile these settings describe (`profileFromLegacy`): what a tenant with no stored profile is given, so the owner's Editor
     * prompt is built through the profile path, not around it.
     */
    editor?: Wording<ProfileContext<'clip_edit'>>;
    /**
     * The kits the pick's and the Marketer's prompts are written from (P11: `reelKitsOf(profile)`, what the sweep's `reelKitsFor`
     * returns), or a function that makes them, so a tenant whose profile cannot be described fails those entries by name. Without
     * them they are the kits of the profile these settings describe (`profileFromLegacy`), as for the Editor.
     */
    reelKits?: Wording<ReelKits>;
}

/**
 * Every builder that reads the Studio settings and nothing else of the tenant: the writer's prompts, the CTA lines,
 * the DM, the caption normalisers, the carousel payload, and the Monteur's pick, copy, Editor, Analyst and render.
 */
export async function studioSurface(settings: StudioSettings, { lang, slug, set = 'elamir', editor, carousel: wording, reelKits, turn = OWNER_TURN }: StudioSurfaceOptions): Promise<SurfaceEntry[]> {
    const { say, activeKeywords, seo } = turn(lang);
    const out: SurfaceEntry[] = [];
    const t = (base: string, build: () => string): void => { out.push(built(named(base, slug), 'text', set, build)); };
    const j = (base: string, build: () => unknown): void => { out.push(built(named(base, slug), 'json', set, build)); };

    // The Studio writer.
    t('studio.system', () => buildSystemPrompt(settings, wordingOf(wording)));
    t('studio.plan-system', () => buildPlanSystemPrompt(settings, wordingOf(wording)));
    j('studio.cta-lines', () => ({ ask: askLine(settings, 'KEYWORD'), save: saveLine(settings), tiktok: tiktokLine(settings) }));

    const fill = lazy(() => ({ url: settings.product.url, bullets: settings.product.dmBullets }));
    t('studio.dm', () => buildDm(settings.cta.dmTemplate, { question: say.question, pitch: say.pitch, ...fill() }));
    const kit = lazy(() => writerKit(wordingOf(wording)));
    t('studio.dm-fallback', () => buildDm(settings.cta.dmTemplate, { question: kit().fallbackQuestion, pitch: kit().fallbackPitch, ...fill() }));

    const catalog = lazy(() => buildCatalog(GOLDEN_SOURCES, settings, say.idea));
    t('studio.catalog', () => catalog().text);
    t('studio.draft-user', () => draftUserPrompt({
        input: { lessonIds: [GOLDEN_LESSON.id], idea: say.idea, angle: 'tips', slides: 8 },
        catalog: catalog(), slides: 8, keyword: null, activeKeywords, recentTopics: say.recent, seo,
    }));

    t('captions.instagram', () => normalizeInstagramCaption(say.igCaption, say.keyword, say.candidates, settings));
    t('captions.tiktok', () => normalizeTiktokCaption(say.ttCaption, say.candidates, settings, kit().learnTags));

    const carousel: Carousel = {
        id: 'LocalAI', accent: '#FFD60A', keyword: say.keyword,
        slides: [
            { kind: 'cover', title: say.idea },
            { kind: 'point', title: say.question, body: say.pitch },
            { kind: 'cta', promise: say.pitch },
        ],
        captions: { instagram: say.igCaption, tiktokTitle: say.idea, tiktok: say.ttCaption },
    };
    out.push(await builtAsync(named('studio.carousel-render-payload', slug), 'json', set, () => carouselRenderPayload('creator', 'draft', carousel, {}, settings)));

    // The Monteur. The pick and the Marketer are written from the creator's profile context (P11): his, here, is what his profile says.
    const reels = lazy(() => wordingOf(reelKits ?? (() => reelKitsOf(profileFromLegacy(settings)))));
    t('monteur.pick-system', () => pickSystemPrompt(settings, reels().pick));
    t('monteur.pick-user', () => pickUserPrompt({
        lines: GOLDEN_LINES, settings, lessons: GOLDEN_LESSONS, reels: GOLDEN_REEL_EVIDENCE, keep: 2, kit: reels().pick,
    }));

    t('monteur.copy-system', () => copySystemPrompt(settings, reels().copy));
    t('monteur.copy-user', () => copyUserPrompt({
        clips: GOLDEN_CLIPS, lines: GOLDEN_LINES, settings, lessons: GOLDEN_LESSONS,
        activeKeywords, recentAsks: [say.recentAsk], seo,
    }));

    const item = { clip: 1, ask_line: 'no keyword here', question: '', pitch: '', ...say.copy };
    j('monteur.copy-clip-fallbacks', () => {
        const ctx: CopyContext = { kit: reels().copy, activeKeywords: [], seo, recentAsks: [] };
        return toClipCopy(item, GOLDEN_CLIPS[0]!, settings, ctx, [], [], 0);
    });

    // The Editor is written from the creator's profile context: his, here, is what `profileFromLegacy` makes of his rows.
    const editorKitOfTenant = lazy(() => editorKit(wordingOf(editor ?? (() => contextFor(profileFromLegacy(settings), 'clip_edit', null)))));
    t('monteur.editor-system.human-on', () => editorSystemPrompt({ ...settings, monteur: { ...settings.monteur, human: true } }, editorKitOfTenant()));
    t('monteur.editor-system.human-off', () => editorSystemPrompt({ ...settings, monteur: { ...settings.monteur, human: false } }, editorKitOfTenant()));

    t('monteur.analyst-system', () => analystSystemPrompt(settings));

    j('monteur.render-payload', () => buildRenderPayload({
        clipId: 'clip', source: { id: 'src', path: '/v/a.mp4', words: [[10, 10.4, 'كلمة'], [10.5, 11, 'ثانية']] },
        start: 9.85, end: 34.8, title: say.copy.first_line, keyword: say.keyword, accent: '#FFD60A', edits: [],
        settings, direction: PLAN,
    }));
    return out;
}

// ─── Infographics ───────────────────────────────────────────────────────────────────────────

/**
 * The job the Mac gets in write mode, in each language, and the personal brand the worker draws, from the
 * settings' `infographic` section. The call site itself, not a copy of it: brand, system prompt, user prompt (with the
 * never-use list from `voice.avoid`) and schema. `spec = null` is write mode, which is how a new one starts. The
 * golden names carry the slug in the middle (`infographic.render-payload.seed.ar`).
 *
 * `ctx` is what the writer's prompt is built from (P12): the `infographic` context of the profile the caller reads the
 * tenant through, handed to the builder exactly as `createInfographic` hands it (`infographicContext`). The surface has no
 * default for it, so a path that forgot to give one fails to compile instead of quietly writing the owner's text. It may be a
 * function that makes it (`Wording`), so a tenant whose profile cannot be made into one fails these entries by name.
 */
export function infographicSurface(settings: StudioSettings, { slug, ctx }: { slug?: string; ctx: Wording<InfographicWriterContext> }): SurfaceEntry[] {
    const mid = slug ? `.${slug}` : '';
    const job = (language: SurfaceLang, notes: string | null) => () => infographicRenderPayload(
        '00000000-0000-4000-8000-0000000000aa', { topic: 'RAG vs CAG vs KAG', notes, language },
        settings.infographic.theme, settings, null, wordingOf(ctx),
    );
    return [
        built(`infographic.render-payload${mid}.ar`, 'json', 'elamir', job('ar', 'ركّز على التكلفة وسرعة الاستجابة')),
        built(`infographic.render-payload${mid}.en`, 'json', 'control', job('en', null)),
        built(named('infographic.brand', slug), 'json', 'elamir', () => payloadBrand(settings.infographic)),
    ];
}

// ─── The DM bot and the comment replies ─────────────────────────────────────────────────────

/** The DM agent's row, as the DM path reads it: `SELECT … FROM ai_agents WHERE creator_id = $1` (`generateAiResponse`). */
export interface AgentPersona { system_prompt: string; knowledge_base: string | null }

/**
 * What the DM bot's wording is built from: the context the tenant's `dm` surface reads (`profileContext(creatorId, 'dm')`,
 * `contextFor(profile, 'dm', version)`): the language and register it speaks and the kind of thing it sells (P8). The
 * owner's gives today's text, byte for byte, and these entries are what prove it: they are built through `dmSystemInstruction`,
 * `dmResponseSchema`, `disclosureLine`, `starterPersona` and `dmFallbackReply` as the DM and comment paths call them.
 */
export type DmWording = DmContext;

/** The register the tenant's comment replies speak: the `comment_reply` context's, as `comments.ts` reads it. */
export type CommentWording = Pick<ProfileContext<'comment_reply'>, 'language'>;

/**
 * A context, or a function that makes one. A tenant whose profile cannot be read into a context fails the entries that need
 * it (each builder runs inside `built`), instead of the whole surface: the rest are still built and compared.
 */
type Wording<T extends object> = T | (() => T);
const wordingOf = <T extends object>(w: Wording<T>): T => (typeof w === 'function' ? w() : w);

/**
 * The system instruction the DM bot sends Gemini: the tenant's persona and knowledge base inside the fixed rules, which the
 * language kit writes from `ctx` (`dmSystemInstruction`). The knowledge base is an agent setting, not a profile field, so both
 * parity paths get the same row: it is here so a release that changes the instruction changes this hash, and the
 * main-against-release diff shows it.
 */
export function dmInstructionSurface(agent: AgentPersona, ctx: Wording<DmWording>): SurfaceEntry[] {
    return [built('dm.system-instruction', 'text', 'elamir', () => dmSystemInstruction(agent.system_prompt, agent.knowledge_base, wordingOf(ctx)))];
}

/**
 * The rest of what the DM path says that depends on who the creator is and not on the agent row: the schema Gemini answers
 * with (the language it asks for, the button id it shows), the first line of an automated DM, and the persona a new agent
 * starts with. All three are in the language the `dm` surface speaks. Where each is called: `generateAiResponse`,
 * `handleMessagingEvent`, and the three starter-persona sites (`ai.ts`, `admin.ts`, `api.ts`).
 */
export function dmContextSurface(ctx: Wording<DmWording>): SurfaceEntry[] {
    return [
        built('dm.response-schema', 'json', 'elamir', () => dmResponseSchema(wordingOf(ctx))),
        built('dm.disclosure-line', 'text', 'elamir', () => disclosureLine(wordingOf(ctx).language.code)),
        built('dm.starter-persona', 'text', 'control', () => starterPersona(wordingOf(ctx).language.code)),
    ];
}

/**
 * The public reply that replaces an undeliverable DM, for the tenant's own DM template, in every variant, in the register
 * its comment surface speaks (`ctx`, `comment_reply`).
 */
export function dmFallbackSurface(settings: StudioSettings, ctx: Wording<CommentWording>, turn: (lang: SurfaceLang) => SurfaceTurn = OWNER_TURN): SurfaceEntry[] {
    // His DMs are Arabic, so the Arabic replies are his; the English ones go to English-language DMs, and do not read his settings.
    const arabic = lazy(() => {
        const register = wordingOf(ctx).language.register;
        const say = turn('ar').say;
        const ownerDm = buildDm(settings.cta.dmTemplate, {
            question: say.question, pitch: say.pitch, url: settings.product.url, bullets: settings.product.dmBullets,
        });
        return [
            { name: 'arabic, instagram', isFacebook: false, dmText: ownerDm },
            { name: 'arabic, facebook, the DM holds a link', isFacebook: true, dmText: ownerDm },
            { name: 'arabic, facebook, the link ends in punctuation', isFacebook: true, dmText: 'هذا الرابط: https://example.com/guide،' },
            { name: 'arabic, facebook, no link in the DM', isFacebook: true, dmText: 'هلا {username} 👋 راسلنا ونرسل لك التفاصيل' },
        ].map((c) => ({ ...c, reply: dmFallbackReply({ ...c, register }) }));
    });
    const english = lazy(() => {
        const register = wordingOf(ctx).language.register;
        const englishDm = 'Hi {username} 👋 Here is the full guide: https://example.com/guide?ref=a.';
        return [
            { name: 'english, instagram', isFacebook: false, dmText: englishDm },
            { name: 'english, facebook, the DM holds a link', isFacebook: true, dmText: englishDm },
            { name: 'english, facebook, no link in the DM', isFacebook: true, dmText: 'Hi {username} 👋 Reply to this message for the details' },
        ].map((c) => ({ ...c, reply: dmFallbackReply({ ...c, register }) }));
    });
    return [
        built('comments.dm-fallback-replies.ar', 'json', 'elamir', arabic),
        built('comments.dm-fallback-replies.en', 'json', 'control', english),
    ];
}

// ─── The DM sales prompt ────────────────────────────────────────────────────────────────────

/** One run of the sales prompt builder: whose data it is read from, and what the entry is called. */
export interface DmSalesRun {
    /** `dm.sales-system`, or `dm.sales-system-filled`: the golden's name before its slug. */
    base: string;
    /** The fixture's suffix (`elamir`, `english`), as `studioSurface` names its own. */
    slug: string;
    set: GoldenSet;
    agent: AgentPersona;
    profile: CreatorProfile;
    /** The tenant's timezone (`identity.timezone`): the hours' zone, and the day a price's "valid until" ends in. */
    timezone: string;
    /** The moment the prompt is for. A parameter, so the golden does not depend on today. */
    now: Date;
    /** The conversation's own facts, the last block. Left out, the entry is the static prefix alone. */
    facts?: SalesFacts;
    /** Also pin the schema the model answers in for this tenant's offers (`dm.sales-schema.<slug>`). */
    schema?: boolean;
}

/**
 * The DM sales prompt (docs/DM_SALES_PLAN.md §3, S5) and, when asked, its answer schema, for one tenant's profile and agent row.
 *
 * **Deliberately not in `tenantSurface`.** That list is what the live parity script hashes on both paths and what `assessOwnerOffers`
 * compares before and after a save of the owner's offers; the sales prompt reads those offers (and the profile's own sales blocks, which
 * no settings row carries), so path (a) could not describe it, and a row of it would turn every edit of an offer into a "prompt moved".
 * Adding it there changes the parity digest and is a decision for S6, when something sends it. Until then it is pinned by goldens alone
 * (`golden.test.ts`), which is what these entries are for.
 */
export function dmSalesSurface(run: DmSalesRun): SurfaceEntry[] {
    const prompt = lazy(() => buildSalesPrompt(
        { persona: run.agent.system_prompt, knowledge: run.agent.knowledge_base, ctx: contextFor(run.profile, 'dm', null), timezone: run.timezone, now: run.now },
        run.facts,
    ));
    return [
        built(named(run.base, run.slug), 'text', run.set, () => prompt().system),
        ...(run.schema ? [built(named('dm.sales-schema', run.slug), 'json', run.set, () => salesReplySchema(prompt().offers.map((o) => o.id)))] : []),
    ];
}

// ─── The Growth coach and the keyword finder ────────────────────────────────────────────────

/** The clock the coach is run at: a parameter of `runCoach`, so nothing here depends on today. */
export const COACH_NOW = new Date('2026-10-13T12:00:00Z');

const row = (id: string, platform: string, type: string, at: string, caption: string, metrics: Record<string, number>) => ({
    id: `row-${id}`, creator_id: 'creator', platform, media_id: id, scheduled_post_id: null, media_type: type,
    permalink: null, caption, thumbnail_url: null, published_at: new Date(at), metrics, fetched_at: COACH_NOW,
});
const REPOSTED = 'نموذج محلي يجاوب من ملفاتك — خطوتين بس';
const POSTS = [
    row('r1', 'instagram', 'REELS', '2026-10-08T16:00:00Z', REPOSTED, { views: 48200, reach: 39100, likes: 2100, comments: 96, saved: 880, shares: 410, avg_watch_time_ms: 9100, skip_rate: 41.5 }),
    row('r2', 'instagram', 'REELS', '2026-10-01T16:00:00Z', 'برومبت واحد يلخص لك أي كتاب', { views: 12900, reach: 10200, likes: 700, comments: 31, saved: 220, shares: 90, avg_watch_time_ms: 6200, skip_rate: 38 }),
    row('r3', 'instagram', 'REELS', '2026-09-27T17:00:00Z', REPOSTED, { views: 2400, reach: 2100, likes: 80, comments: 4, saved: 12, shares: 3, avg_watch_time_ms: 3100, skip_rate: 91.2 }),
    row('v1', 'facebook', 'VIDEO', '2026-10-06T16:00:00Z', 'برومبت واحد يلخص لك أي كتاب', { views: 3100, reach: 2800, likes: 120, comments: 9, shares: 14, avg_watch_time_ms: 5400 }),
    row('c1', 'instagram', 'CAROUSEL_ALBUM', '2026-09-24T15:00:00Z', 'سياق الذكاء الاصطناعي في ٥ طبقات', { reach: 4000, likes: 300, comments: 22, saved: 120, shares: 40 }),
];
const DAYS = [
    { platform: 'instagram', day: '2026-10-05', metrics: { reach_followers: 420, reach_non_followers: 9800, followers: 8310 } },
    { platform: 'instagram', day: '2026-10-08', metrics: { reach_followers: 910, reach_non_followers: 31200, followers: 8355 } },
    { platform: 'instagram', day: '2026-10-12', metrics: { reach_followers: 300, reach_non_followers: 4100, followers: 8412 } },
];

/** The tenant's rows as the Growth readers and the profile context behind `tenantLanguage` / `tenantTimezone` read them (a tenant with no stored profile is described from them). */
export interface GrowthRows { growth: GrowthSettings; studio: StudioSettings }

/** What `withRows` can be told beyond the rows. */
export interface WithRowsOptions {
    /**
     * A stored profile (as the database holds it) for the stored-profile lookup to answer with. Without one the lookup is
     * answered "none". The golden test passes one on its "through the real readers" path (the readers do the overlay), and
     * `runParity` passes one on path (b) for a tenant that has one stored: the Growth coach reads its language from the
     * profile context (`language.surfaces.coach`), which the rows alone cannot say, so without it a stored coach override
     * would change the coach and show no drift. Path (a) never does: it is today's rows, and a profile laid over them is what (b) is.
     */
    storedProfile?: unknown;
}

/**
 * `body` run with the pool answering from `rows`: the Growth readers and the language lookup get the tenant's
 * rows, the insight queries get fixed evidence, the stored-profile lookup is answered "none" (unless the golden test
 * supplies one: `WithRowsOptions.storedProfile`), and a query it has no answer
 * for is refused by name (so a reader that starts asking something new fails here, loudly, instead of being handed an empty
 * result it may quietly work around). Nothing reaches a database. The pool is put back, and the log sink too, whatever
 * `body` does. Exported for its test; the surfaces below are the callers.
 */
export async function withRows<T>(rows: GrowthRows, body: () => Promise<T>, { storedProfile }: WithRowsOptions = {}): Promise<T> {
    const original = { query: pool.query, connect: pool.connect };
    const sink = setLogSink(() => {});
    (pool as any).query = async (sql: string) => {
        const q = sql.replace(/\s+/g, ' ');
        if (/FROM post_insights/.test(q)) return { rows: POSTS };
        if (/DISTINCT ON \(platform\)/.test(q)) return { rows: [{ platform: 'instagram', followers: 8412 }] };
        if (/FROM account_insights_daily/.test(q)) return { rows: DAYS };
        if (/SELECT last_sync FROM growth_settings/.test(q)) return { rows: [] };
        // The rows handed in ARE the answer: path (b)'s are already the profile's view. A reader that lays a stored profile
        // over them (P4's `getStudioSettings`) must find none, or (b) would be a view of a view. Only the golden test's
        // "through the real readers" path hands in the stored rows and a stored profile instead (`storedProfile`).
        if (/FROM creator_profiles/.test(q)) return { rows: storedProfile === undefined ? [] : [{ profile: storedProfile, version: 1, activated_at: null }] };
        if (/FROM growth_settings/.test(q)) return { rows: [{ ...rows.growth }] };
        if (/FROM studio_settings/.test(q)) return { rows: [{ ...rows.studio }] };
        throw new Error(`the prompt surface has no answer for: ${q.slice(0, 80)}`);
    };
    // A builder that opens a transaction here is reaching for a database: refuse, rather than hand it a real client.
    (pool as any).connect = async () => { throw new Error('the prompt surface never opens a database connection'); };
    try {
        return await body();
    } finally {
        (pool as any).query = original.query;
        (pool as any).connect = original.connect;
        setLogSink(sink);
    }
}

/**
 * The keyword finder's system prompt and turn, and the coach's system prompt and numbers, for the tenant's Growth
 * settings, timezone and language. The language the tenant speaks is in the name of what it is written in
 * (`growth.coach-system.ar`), so a tenant that no longer speaks Arabic fails to find its golden rather than being
 * compared against another language's.
 */
export async function growthSurface(rows: GrowthRows, { slug, storedProfile }: { slug?: string } & WithRowsOptions = {}): Promise<SurfaceEntry[]> {
    return withRows(rows, async () => {
        const out: SurfaceEntry[] = [];
        const setOf = (code: string): GoldenSet => (code === 'ar' ? 'elamir' : 'control');
        const failed = (base: string, err: unknown): SurfaceEntry => ({ name: named(base, slug), kind: 'text', set: 'elamir', value: undefined, error: describeFailure(err) });

        try {
            const keywordRequests: ModelRequest[] = [];
            const keywordsCall: CallModel = async (req) => {
                keywordRequests.push(req);
                return { keywords: [{ term: 'هندسة البرومبت', why: 'يبحث عنها المبتدئون' }], hashtags: ['#برومبت'] };
            };
            const keywords = await suggestKeywords('creator', { topic: 'هندسة البرومبت للمبتدئين' }, { callModel: keywordsCall });
            if (keywordRequests.length !== 1) throw new Error(`the keyword finder made ${keywordRequests.length} model calls, not one`);
            if (keywordRequests[0]!.system !== keywordsSystemPrompt(keywords.language)) throw new Error('the keyword finder\'s system prompt is not the one for its language');
            out.push(text(`growth.keywords-system.${keywords.language}`, setOf(keywords.language), keywordRequests[0]!.system));
            out.push(text(named('growth.keywords-user', slug), 'elamir', keywordRequests[0]!.turns[0]!.text));
        } catch (err) {
            out.push(failed('growth.keywords', err));
        }

        try {
            const coachRequests: ModelRequest[] = [];
            const coachCall: CallModel = async (req) => {
                coachRequests.push(req);
                return { summary: 'ملخص', actions: [{ title: 'اقطع المقدمة', why: '٣ ثوانٍ', how: 'ابدأ بالنتيجة', effort: 'low', impact: 'high' }] };
            };
            const coach = await runCoach('creator', { callModel: coachCall, now: COACH_NOW });
            if (coachRequests.length !== 1) throw new Error(`the coach made ${coachRequests.length} model calls, not one`);
            if (coachRequests[0]!.system !== coachSystemPrompt(coach.language)) throw new Error('the coach\'s system prompt is not the one for its language');
            out.push(text(`growth.coach-system.${coach.language}`, setOf(coach.language), coachRequests[0]!.system));
            out.push(text(named('growth.coach-user', slug), 'elamir', coachRequests[0]!.turns[0]!.text));
        } catch (err) {
            out.push(failed('growth.coach', err));
        }
        return out;
    }, { storedProfile });
}

// ─── The whole surface of a live tenant ─────────────────────────────────────────────────────

/**
 * A tenant's rows, and the DM agent's persona when it has one. `profile` is the profile the rows are read through (path (b)
 * of the parity script: the stored one): the infographic writer reads its role, domain and register from its context (P12),
 * and the DM and comment wording reads its language, register and kind of offer (P8). Without one the tenant is described by
 * its rows alone, `profileFromLegacy`, which is today's path (and what those paths said before them): so a stored profile that
 * says something else is a difference between the two paths, as it should be.
 */
export interface TenantRows extends GrowthRows {
    agent?: AgentPersona | null;
    profile?: CreatorProfile;
    /** The story the Studio's and the Monteur's builders are fed (`StudioSurfaceOptions.turn`); the owner's unless a test says otherwise. */
    turn?: (lang: SurfaceLang) => SurfaceTurn;
}

/**
 * Everything above, for one tenant's rows, with no fixture suffix: what `prompt-parity.mts` hashes. Called twice per
 * tenant, once with the rows as stored and once with the same rows read through the profile. A tenant with no agent row
 * has no DM instruction to hash.
 */
export async function tenantSurface(rows: TenantRows, options: WithRowsOptions = {}): Promise<SurfaceEntry[]> {
    // Made on first use, and by the entries that use them, so a tenant whose rows cannot be described fails those builders by name.
    const profile = lazy(() => rows.profile ?? profileFromLegacy(rows.studio, rows.growth));
    const dm = () => contextFor(profile(), 'dm', null);
    const comments = () => contextFor(profile(), 'comment_reply', null);
    const carousel = (): StudioWording => contextFor(profile(), 'carousel', null);
    return [
        ...await studioSurface(rows.studio, { lang: rows.studio.voice.language, editor: () => contextFor(profile(), 'clip_edit', null), carousel, reelKits: () => reelKitsOf(profile()), turn: rows.turn }),
        ...infographicSurface(rows.studio, { ctx: () => contextFor(profile(), 'infographic', null) }),
        ...(rows.agent ? dmInstructionSurface(rows.agent, dm) : []),
        ...dmContextSurface(dm),
        ...dmFallbackSurface(rows.studio, comments, rows.turn),
        ...await growthSurface(rows, options),
    ];
}
