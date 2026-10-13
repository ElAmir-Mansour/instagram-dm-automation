/**
 * Golden prompts for the owner's tenant (docs/onboarding/01 §5, 05 §3): the exact text every
 * builder writes for him today, committed under `__golden__/elamir`. The tenant-onboarding PRs
 * move his values out of code and into his profile; each must leave these files untouched.
 *
 * Path (a), "today's path": `builder(fixture)`. The fixtures are `ELAMIR_SETTINGS` (testFixtures.ts)
 * and `ELAMIR_SEED_SETTINGS` (what `scripts/seed-studio-settings.mjs` writes: only it pins the
 * infographic brand), with `.elamir` and `.seed` in the file names. `__golden__/elamir` is only what
 * he is served, in Arabic. `__golden__/control-english` holds what he never is: the neutral English
 * fixture, the English halves of bilingual builders, and the starter defaults a new tenant gets. It
 * is meant to change as defaults go neutral.
 *
 * Path (b), "through the profile" (01 §5): every builder that reads the owner's settings is also handed
 * `studioView(scramble(fixture), profile)`, the stored row with every profile-owned field overwritten by
 * junk and then read back from the owner's profile, `profileFromLegacy(fixture, growth)` after the trip a
 * stored profile makes: serialised, its keys reordered the way Postgres does, and read through
 * `upgradeProfile`. It must write the same bytes into the same goldens: that is what lets P4 return the
 * view from the readers without a prompt moving. The growth goldens take their audience and goals the same
 * way. Anything the profile failed to carry would show here as junk in a prompt. Under UPDATE_GOLDEN=1 the
 * two paths must also agree before a file is written (golden.ts refuses to write one file twice with
 * different bytes), so regenerating cannot hide a disagreement.
 *
 * Path (c), "through the real readers" (P4): the owner's row (its profile-owned fields scrambled) and his stored profile are
 * put in a stand-in database, and the builders are handed what the real `getStudioSettings` and `getGrowthSettings` return.
 * Path (b) proves the view; this proves the readers return it, over the statements they send, jsonb's key order
 * included. The same goldens again: dropping the overlay from a reader fails here, and nowhere that reads a fixture.
 *
 * The DM instruction has no path (b): its knowledge base is an agent setting, not a profile field, and the
 * DM path reads nothing else from the profile until P8 gives it a profile context.
 *
 * Nothing here depends on the clock or on chance: the builders take their dates as parameters
 * (`runCoach`'s `now`) or embed none, and every input is a fixed fixture.
 *
 * Regenerate with `UPDATE_GOLDEN=1 npx tsx --test src/services/profile/golden.test.ts`, and only for a
 * change that is meant for the owner (docs/onboarding/05 §3).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import vm from 'node:vm';
import { pool } from '../../config/db.js';
import type { ClipDirection } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { dmFallbackReply } from '../../webhook/errors.js';
import { AI_DISCLOSURE_LINE } from '../../webhook/meta-payload.js';
import { dmSystemInstruction, RESPONSE_SCHEMA, STARTER_PERSONA } from '../ai.js';
import { COACH_SCHEMA, coachSystemPrompt, runCoach } from '../growth/coach.js';
import { KEYWORDS_SCHEMA, keywordsSystemPrompt, suggestKeywords } from '../growth/keywords.js';
import { analystSystemPrompt, analystUserPrompt, LESSONS_SCHEMA } from '../monteur/analyst.js';
import {
    ASK_POOL, COPY_SCHEMA, copySystemPrompt, copyUserPrompt, toClipCopy, type CopyContext,
} from '../monteur/copy.js';
import { editorSchema, editorSystemPrompt, HUMAN_TOUCHES_PROMPT } from '../monteur/editor.js';
import { PICK_SCHEMA, pickSystemPrompt, pickUserPrompt } from '../monteur/pick.js';
import { buildRenderPayload } from '../monteur/render.js';
import type { Carousel } from '../studio/carouselTypes.js';
import { renderPayload as carouselRenderPayload } from '../studio/drafts.js';
import {
    DRAFT_SCHEMA, normalizeInstagramCaption, normalizeTiktokCaption, PLAN_SCHEMA, type CallModel, type ModelRequest,
} from '../studio/generate.js';
import { payloadBrand, WRITE_SCHEMA, writeSystemPrompt } from '../studio/infographicSpec.js';
import { renderPayload as infographicRenderPayload } from '../studio/infographics.js';
import {
    askLine, buildCatalog, buildDm, buildPlanCatalog, buildPlanSystemPrompt, buildSystemPrompt, draftUserPrompt,
    languageKit, LANGUAGES, planUserPrompt, saveLine, tiktokLine,
} from '../studio/prompts.js';
import type { StudioSettings } from '../studio/settingsTypes.js';
import type { GrowthSettings } from '../../db/rows.js';
import {
    ELAMIR_AGENT, ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS, ELAMIR_SEO, ELAMIR_SETTINGS, ENGLISH_SETTINGS, GOLDEN_CLIPS,
    GOLDEN_LESSON, GOLDEN_LESSONS, GOLDEN_LINES, GOLDEN_REEL_EVIDENCE, GOLDEN_REELS, GOLDEN_SOURCES, GOLDEN_UNINDEXED_LESSON,
} from '../studio/testFixtures.js';
import { videoResource } from '../youtube.js';
import { getGrowthSettings } from '../growth/settings.js';
import { defaultGrowthSettings } from '../growth/settingsRow.js';
import { getStudioSettings } from '../studio/settings.js';
import { matchGolden, matchGoldenJson, uncheckedGoldens, type GoldenSet } from './golden.js';
import { upgradeProfile } from './defaults.js';
import { profileFromLegacy } from './legacy.js';
import { emptyState, growthRow, installProfileDb, OWNER, studioRow } from './testDb.js';
import { scramble, throughJsonb } from './testSupport.js';
import type { CreatorProfile } from './types.js';
import { GROWTH_PROFILE_PATHS, growthView, STUDIO_PROFILE_PATHS, studioView } from './views.js';

// ─── The fixtures under test ────────────────────────────────────────────────────────────────

/**
 * A tenant's profile as P4 will read it: described from its rows (`profileFromLegacy`), then stored and read
 * back. JSONB hands the keys back sorted by length and then bytes, whatever order they were written in, so a
 * reader that only works on the order a profile was built in works here and fails in production.
 */
const storedProfile = (settings: StudioSettings, growth?: GrowthSettings): CreatorProfile => {
    const { profile, repaired, newerSchema } = upgradeProfile(throughJsonb(profileFromLegacy(settings, growth)));
    assert.deepStrictEqual(repaired, [], 'a profile this release wrote has nothing to repair');
    assert.equal(newerSchema, false);
    return profile;
};

/**
 * Path (b): `settings` as the profile gives them back. The row is scrambled first, so nothing survives
 * from it that the profile does not own. The owner's fixtures also bring his Growth settings, the other
 * row his profile is read from.
 */
const through = (settings: StudioSettings, owner: boolean): StudioSettings => studioView(
    scramble(settings, STUDIO_PROFILE_PATHS),
    storedProfile(settings, owner ? ELAMIR_GROWTH : undefined),
);

/**
 * Path (c): what the real readers return for a tenant whose profile is stored. The stored rows hold junk in every
 * profile-owned field (nothing may survive from them), the profile is `profileFromLegacy` as the database holds it, and
 * the answers are what `getStudioSettings` and `getGrowthSettings` give over those statements.
 */
async function throughTheReaders(settings: StudioSettings, growth?: GrowthSettings): Promise<{ studio: StudioSettings; growth: GrowthSettings }> {
    const state = emptyState();
    state.studio.set(OWNER, studioRow(scramble(settings, STUDIO_PROFILE_PATHS)));
    state.growth.set(OWNER, growthRow(scramble(growth ?? defaultGrowthSettings(), GROWTH_PROFILE_PATHS)));
    state.profiles.set(OWNER, { profile: throughJsonb(profileFromLegacy(settings, growth)), version: 1, activated_at: null, updated_by: null });
    const db = installProfileDb(state);
    const restoreSink = setLogSink(() => {});
    try {
        const studio = await getStudioSettings(OWNER);
        const read = await getGrowthSettings(OWNER);
        assert.ok(!JSON.stringify([studio, read]).includes('JUNK:'), 'nothing survives from the stale row that the profile owns');
        assert.equal(db.ran(/FROM creator_profiles/).length, 2, 'the readers asked for the stored profile');
        return { studio, growth: read };
    } finally {
        setLogSink(restoreSink);
        db.restore();
    }
}

type Variant = {
    slug: 'elamir' | 'seed' | 'english'; settings: StudioSettings; set: GoldenSet; lang: 'ar' | 'en';
    /** How the builder is handed the settings: as they are, as the owner's profile gives them back, or as the real readers return them. */
    via: 'today' | 'profile' | 'readers';
};
const FIXTURES = [
    { slug: 'elamir', settings: ELAMIR_SETTINGS, set: 'elamir', lang: 'ar', owner: true },
    { slug: 'seed', settings: ELAMIR_SEED_SETTINGS, set: 'elamir', lang: 'ar', owner: true },
    { slug: 'english', settings: ENGLISH_SETTINGS, set: 'control', lang: 'en', owner: false },
] as const;
/** What the real readers return for each fixture (path (c)). Read once, before any test: it swaps the pool for a stand-in and puts it back. */
const READER_SETTINGS = {} as Record<(typeof FIXTURES)[number]['slug'], { studio: StudioSettings; growth: GrowthSettings }>;
// One at a time: each swaps the one shared pool for its own stand-in.
for (const f of FIXTURES) READER_SETTINGS[f.slug] = await throughTheReaders(f.settings, f.owner ? ELAMIR_GROWTH : undefined);
/** Each fixture three times, into the same golden: as it is, through the profile, and through the real readers. */
const VARIANTS: readonly Variant[] = FIXTURES.flatMap((f): Variant[] => [
    { slug: f.slug, settings: f.settings, set: f.set, lang: f.lang, via: 'today' },
    { slug: f.slug, settings: through(f.settings, f.owner), set: f.set, lang: f.lang, via: 'profile' },
    { slug: f.slug, settings: READER_SETTINGS[f.slug].studio, set: f.set, lang: f.lang, via: 'readers' },
]);
const describeVariant = (v: Variant): string => `${v.slug} settings${v.via === 'profile' ? ', through the profile' : v.via === 'readers' ? ', through the real readers' : ''}`;
/** `<name>.<fixture>`: the owner's two fixtures in his set, the English control in its own. */
const text = (v: Variant, name: string, actual: string): void => matchGolden(`${name}.${v.slug}`, actual, v.set);
const json = (v: Variant, name: string, value: unknown): void => matchGoldenJson(`${name}.${v.slug}`, value, v.set);

/** The same story in each language, so the English control is fed English. */
const SAY = {
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
} as const;

// ─── The fixtures are the owner's real values ───────────────────────────────────────────────

describe('the fixtures hold the owner\'s real values', () => {
    it('ELAMIR_AGENT is what schema_migration_v2.sql wrote into his ai_agents row', () => {
        const sql = readFileSync(new URL('../../config/schema_migration_v2.sql', import.meta.url), 'utf8');
        const m = /as creator_id,\s*'((?:[^']|'')*)' as system_prompt,\s*'((?:[^']|'')*)' as knowledge_base,/.exec(sql);
        assert.ok(m, 'the seed INSERT is still in the migration');
        assert.equal(ELAMIR_AGENT.system_prompt, m[1]!.replace(/''/g, '\''));
        assert.equal(ELAMIR_AGENT.knowledge_base, m[2]!.replace(/''/g, '\''));
    });

    it('ELAMIR_SEED_SETTINGS is the STUDIO_SETTINGS scripts/seed-studio-settings.mjs writes', async () => {
        const seed = await import(new URL('../../../scripts/seed-studio-settings.mjs', import.meta.url).href);
        assert.deepStrictEqual(ELAMIR_SEED_SETTINGS, seed.STUDIO_SETTINGS);
        // The prompts print some of these objects as JSON, so their key order is part of the value.
        assert.equal(JSON.stringify(ELAMIR_SEED_SETTINGS), JSON.stringify(seed.STUDIO_SETTINGS));
    });

    it('the seed pins the infographic brand the other fixture leaves neutral', () => {
        assert.equal(ELAMIR_SEED_SETTINGS.infographic.site, 'elamirmansour.dev');
        assert.equal(ELAMIR_SETTINGS.infographic.site, '');
    });
});

// ─── The DM bot and the comment replies ─────────────────────────────────────────────────────

describe('DM and comment golden prompts', () => {
    it('dmSystemInstruction: his persona and knowledge base inside the fixed rules', () => {
        matchGolden('dm.system-instruction', dmSystemInstruction(ELAMIR_AGENT.system_prompt, ELAMIR_AGENT.knowledge_base));
    });

    it('RESPONSE_SCHEMA: what Gemini is asked to answer a DM with', () => {
        matchGoldenJson('dm.response-schema', RESPONSE_SCHEMA);
    });

    it('AI_DISCLOSURE_LINE: the first line of an automated DM', () => {
        matchGolden('dm.disclosure-line', AI_DISCLOSURE_LINE);
    });

    it('STARTER_PERSONA: the persona a new tenant\'s agent row, the sandbox and GET /settings/ai start with', () => {
        // The owner's agent row holds his own persona (ELAMIR_AGENT): this is what a NEW tenant gets.
        matchGolden('dm.starter-persona', STARTER_PERSONA, 'control');
    });

    for (const [via, owner] of [['today', ELAMIR_SETTINGS], ['through the profile', through(ELAMIR_SETTINGS, true)], ['through the real readers', READER_SETTINGS.elamir.studio]] as const) it(`dmFallbackReply: the public reply that replaces an undeliverable DM, every variant (${via})`, () => {
        const ownerDm = buildDm(owner.cta.dmTemplate, {
            question: SAY.ar.question, pitch: SAY.ar.pitch, url: owner.product.url, bullets: owner.product.dmBullets,
        });
        const englishDm = 'Hi {username} 👋 Here is the full guide: https://example.com/guide?ref=a.';
        const cases = [
            { name: 'arabic, instagram', isFacebook: false, dmText: ownerDm },
            { name: 'arabic, facebook, the DM holds a link', isFacebook: true, dmText: ownerDm },
            { name: 'arabic, facebook, the link ends in punctuation', isFacebook: true, dmText: 'هذا الرابط: https://example.com/guide،' },
            { name: 'arabic, facebook, no link in the DM', isFacebook: true, dmText: 'هلا {username} 👋 راسلنا ونرسل لك التفاصيل' },
            { name: 'english, instagram', isFacebook: false, dmText: englishDm },
            { name: 'english, facebook, the DM holds a link', isFacebook: true, dmText: englishDm },
            { name: 'english, facebook, no link in the DM', isFacebook: true, dmText: 'Hi {username} 👋 Reply to this message for the details' },
        ];
        const replies = cases.map((c) => ({ ...c, reply: dmFallbackReply(c) }));
        // His DMs are Arabic, so the Arabic replies are his; the English ones go to English-language DMs.
        matchGoldenJson('comments.dm-fallback-replies.ar', replies.filter((r) => r.name.startsWith('arabic')));
        matchGoldenJson('comments.dm-fallback-replies.en', replies.filter((r) => r.name.startsWith('english')), 'control');
    });
});

// ─── The Studio writer ──────────────────────────────────────────────────────────────────────

describe('Studio golden prompts', () => {
    it('LANGUAGES: the language kits', () => {
        matchGoldenJson('studio.language-kit.ar', LANGUAGES.ar);
        matchGoldenJson('studio.language-kit.en', LANGUAGES.en, 'control');
    });

    it('DRAFT_SCHEMA and PLAN_SCHEMA: what the writer and the planner answer with', () => {
        matchGoldenJson('studio.draft-schema', DRAFT_SCHEMA);
        matchGoldenJson('studio.plan-schema', PLAN_SCHEMA);
    });

    it('buildPlanCatalog and planUserPrompt: the week planner\'s turn', () => {
        const catalog = buildPlanCatalog([GOLDEN_LESSON, GOLDEN_UNINDEXED_LESSON]);
        matchGolden('studio.plan-catalog', catalog.text);
        matchGolden('studio.plan-user', planUserPrompt(5, catalog, SAY.ar.recent));
    });

    for (const v of VARIANTS) {
        describe(describeVariant(v), () => {
            const say = SAY[v.lang];

            it('buildSystemPrompt: the writer\'s system prompt', () => {
                text(v, 'studio.system', buildSystemPrompt(v.settings));
            });

            it('buildPlanSystemPrompt: the planner\'s system prompt', () => {
                text(v, 'studio.plan-system', buildPlanSystemPrompt(v.settings));
            });

            it('askLine, saveLine, tiktokLine: the CTA lines', () => {
                json(v, 'studio.cta-lines', { ask: askLine(v.settings, 'KEYWORD'), save: saveLine(v.settings), tiktok: tiktokLine(v.settings) });
            });

            it('buildDm: the DM from the model\'s question and pitch, and from the language kit\'s fallbacks', () => {
                const fill = { url: v.settings.product.url, bullets: v.settings.product.dmBullets };
                text(v, 'studio.dm', buildDm(v.settings.cta.dmTemplate, { question: say.question, pitch: say.pitch, ...fill }));
                const kit = languageKit(v.settings);
                text(v, 'studio.dm-fallback', buildDm(v.settings.cta.dmTemplate, { question: kit.fallbackQuestion, pitch: kit.fallbackPitch, ...fill }));
            });

            it('buildCatalog and draftUserPrompt: the writer\'s turn', () => {
                const catalog = buildCatalog(GOLDEN_SOURCES, v.settings, say.idea);
                text(v, 'studio.catalog', catalog.text);
                text(v, 'studio.draft-user', draftUserPrompt({
                    input: { lessonIds: [GOLDEN_LESSON.id], idea: say.idea, angle: 'tips', slides: 8 },
                    catalog, slides: 8, keyword: null, activeKeywords: ['وكيل', 'سياق'], recentTopics: say.recent, seo: ELAMIR_SEO,
                }));
            });

            it('normalizeInstagramCaption and normalizeTiktokCaption: his ask, save and link lines, and the learning tags', () => {
                text(v, 'captions.instagram', normalizeInstagramCaption(say.igCaption, say.keyword, say.candidates, v.settings));
                text(v, 'captions.tiktok', normalizeTiktokCaption(say.ttCaption, say.candidates, v.settings));
            });

            it('renderPayload: the brand, CTA words and facts the carousel render job carries', async () => {
                const carousel: Carousel = {
                    id: 'LocalAI', accent: '#FFD60A', keyword: say.keyword,
                    slides: [
                        { kind: 'cover', title: say.idea },
                        { kind: 'point', title: say.question, body: say.pitch },
                        { kind: 'cta', promise: say.pitch },
                    ],
                    captions: { instagram: say.igCaption, tiktokTitle: say.idea, tiktok: say.ttCaption },
                };
                json(v, 'studio.carousel-render-payload', await carouselRenderPayload('creator', 'draft', carousel, {}, v.settings));
            });
        });
    }
});

// ─── The Monteur ────────────────────────────────────────────────────────────────────────────

const PLAN: ClipDirection = {
    cuts: [{ t: 2.5, shot: 'close' }, { t: 8, shot: 'wide' }],
    doodles: [{ t: 3.1, shape: 'arrow', target: 'head' }],
    freezes: [{ t: 9.4, text: 'استنى' }],
    transitions: [{ t: 12, kind: 'glitch' }],
    behind: [{ t: 5, text: 'عشرة أضعاف' }],
    emphasis: [2.5, 6.25],
};

describe('Monteur golden prompts', () => {
    it('ASK_POOL: the built-in asks, Arabic his and English the control\'s', () => {
        matchGoldenJson('monteur.copy.ask-pool.ar', ASK_POOL.ar);
        matchGoldenJson('monteur.copy.ask-pool.en', ASK_POOL.en, 'control');
    });

    it('the schemas the pick, the copy and the Analyst answer with, and the Editor\'s with touches on and off', () => {
        matchGoldenJson('monteur.pick-schema', PICK_SCHEMA);
        matchGoldenJson('monteur.copy-schema', COPY_SCHEMA);
        matchGoldenJson('monteur.analyst-schema', LESSONS_SCHEMA);
        matchGoldenJson('monteur.editor-schema.human-on', editorSchema(true));
        matchGoldenJson('monteur.editor-schema.human-off', editorSchema(false));
    });

    it('HUMAN_TOUCHES_PROMPT: the Editor\'s human-touch rules', () => {
        matchGolden('monteur.editor-human-touches', HUMAN_TOUCHES_PROMPT);
    });

    it('analystUserPrompt: the Analyst\'s turn, with rules and the reach split, and on a cold start', () => {
        matchGolden('monteur.analyst-user', analystUserPrompt({ reels: GOLDEN_REELS, current: GOLDEN_LESSONS, share: 0.97 }));
        matchGolden('monteur.analyst-user-cold-start', analystUserPrompt({ reels: GOLDEN_REELS.slice(0, 1), current: [], share: null }));
    });

    for (const v of VARIANTS) {
        describe(describeVariant(v), () => {
            const say = SAY[v.lang];

            it('pickSystemPrompt and pickUserPrompt', () => {
                text(v, 'monteur.pick-system', pickSystemPrompt(v.settings));
                text(v, 'monteur.pick-user', pickUserPrompt({
                    lines: GOLDEN_LINES, settings: v.settings, lessons: GOLDEN_LESSONS, reels: GOLDEN_REEL_EVIDENCE, keep: 2,
                }));
            });

            it('copySystemPrompt and copyUserPrompt', () => {
                text(v, 'monteur.copy-system', copySystemPrompt(v.settings));
                text(v, 'monteur.copy-user', copyUserPrompt({
                    clips: GOLDEN_CLIPS, lines: GOLDEN_LINES, settings: v.settings, lessons: GOLDEN_LESSONS,
                    activeKeywords: ['وكيل', 'سياق'], recentAsks: [say.recentAsk], seo: ELAMIR_SEO,
                }));
            });

            it('toClipCopy: a clip\'s copy when the model\'s ask, question and pitch are unusable (the built-in fallbacks)', () => {
                const ctx: CopyContext = { activeKeywords: [], seo: ELAMIR_SEO, recentAsks: [] };
                const item = { clip: 1, ask_line: 'no keyword here', question: '', pitch: '', ...say.copy };
                json(v, 'monteur.copy-clip-fallbacks', toClipCopy(item, GOLDEN_CLIPS[0]!, v.settings, ctx, [], [], 0));
            });

            it('editorSystemPrompt: with the human touches on and off', () => {
                const on = { ...v.settings, monteur: { ...v.settings.monteur, human: true } };
                const off = { ...v.settings, monteur: { ...v.settings.monteur, human: false } };
                text(v, 'monteur.editor-system.human-on', editorSystemPrompt(on));
                text(v, 'monteur.editor-system.human-off', editorSystemPrompt(off));
            });

            it('analystSystemPrompt', () => {
                text(v, 'monteur.analyst-system', analystSystemPrompt(v.settings));
            });

            it('buildRenderPayload: the brand, CTA cards and touches the worker renders with', () => {
                json(v, 'monteur.render-payload', buildRenderPayload({
                    clipId: 'clip', source: { id: 'src', path: '/v/a.mp4', words: [[10, 10.4, 'كلمة'], [10.5, 11, 'ثانية']] },
                    start: 9.85, end: 34.8, title: say.copy.first_line, keyword: say.keyword, accent: '#FFD60A', edits: [],
                    settings: v.settings, direction: PLAN,
                }));
            });
        });
    }
});

// ─── Infographics ───────────────────────────────────────────────────────────────────────────

describe('Infographic golden prompts', () => {
    it('writeSystemPrompt: Arabic (فصحى) is his; English is the control\'s', () => {
        matchGolden('infographic.system.ar', writeSystemPrompt('ar'));
        matchGolden('infographic.system.en', writeSystemPrompt('en'), 'control');
    });

    for (const [via, seed] of [['today', ELAMIR_SEED_SETTINGS], ['through the profile', through(ELAMIR_SEED_SETTINGS, true)], ['through the real readers', READER_SETTINGS.seed.studio]] as const) {
        it(`renderPayload: the job the Mac gets in write mode, assembled from his seed settings (${via})`, () => {
            // The call site itself, not a copy of it: brand, system prompt, user prompt (with his never-use
            // list from voice.avoid) and schema. spec = null is write mode, which is how a new one starts.
            const job = (language: 'ar' | 'en', notes: string | null) => infographicRenderPayload(
                '00000000-0000-4000-8000-0000000000aa', { topic: 'RAG vs CAG vs KAG', notes, language },
                seed.infographic.theme, seed, null,
            );
            matchGoldenJson('infographic.render-payload.seed.ar', job('ar', 'ركّز على التكلفة وسرعة الاستجابة'));
            matchGoldenJson('infographic.render-payload.seed.en', job('en', null), 'control');
        });

        it(`payloadBrand: the personal brand the worker draws, from the seed's infographic section (${via})`, () => {
            matchGoldenJson('infographic.brand.seed', payloadBrand(seed.infographic));
        });
    }

    it('WRITE_SCHEMA: what Claude answers an infographic with', () => {
        matchGoldenJson('infographic.write-schema', WRITE_SCHEMA);
    });
});

// ─── YouTube ────────────────────────────────────────────────────────────────────────────────

describe('YouTube golden payloads', () => {
    it('videoResource: every upload is categorised as Education, and declared not made for kids', () => {
        matchGoldenJson('youtube.video-resource', videoResource({
            title: SAY.ar.copy.first_line, description: SAY.ar.copy.body, tags: ['ذكاء_اصطناعي', 'LMStudio'], privacy: 'public', language: 'ar',
        }));
    });
});

// ─── The Growth coach ───────────────────────────────────────────────────────────────────────

describe('Growth coach golden prompts', () => {
    const NOW = new Date('2026-10-13T12:00:00Z');
    const original = { query: pool.query };
    let restoreSink: (() => void) | undefined;
    before(() => {
        const previous = setLogSink(() => {});
        restoreSink = () => setLogSink(previous);
    });
    after(() => {
        restoreSink?.();
        (pool as any).query = original.query;
    });

    const row = (id: string, platform: string, type: string, at: string, caption: string, metrics: Record<string, number>) => ({
        id: `row-${id}`, creator_id: 'creator', platform, media_id: id, scheduled_post_id: null, media_type: type,
        permalink: null, caption, thumbnail_url: null, published_at: new Date(at), metrics, fetched_at: NOW,
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

    /**
     * His rows as the Growth readers and the Studio settings behind `tenantLanguage` read them: as they are
     * (path a), or as the profile gives them back from a scrambled row (path b).
     */
    type Rows = { growth: GrowthSettings; studio: StudioSettings; /** The stored profile the database answers with, when it has one. */ profile?: unknown };
    const TODAY: Rows = { growth: ELAMIR_GROWTH, studio: ELAMIR_SEED_SETTINGS };
    const profile = storedProfile(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);
    const THROUGH_THE_PROFILE: Rows = {
        growth: growthView(scramble(ELAMIR_GROWTH, GROWTH_PROFILE_PATHS), profile),
        studio: studioView(scramble(ELAMIR_SEED_SETTINGS, STUDIO_PROFILE_PATHS), profile),
    };
    // Path (c): the database holds the scrambled rows and the stored profile; the real readers do the overlay.
    const THROUGH_THE_REAL_READERS: Rows = {
        growth: scramble(ELAMIR_GROWTH, GROWTH_PROFILE_PATHS),
        studio: scramble(ELAMIR_SEED_SETTINGS, STUDIO_PROFILE_PATHS),
        profile: throughJsonb(profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH)),
    };
    const PATHS = [['today', TODAY], ['through the profile', THROUGH_THE_PROFILE], ['through the real readers', THROUGH_THE_REAL_READERS]] as const;

    const mockDatabase = (rows: Rows = TODAY): void => {
        (pool as any).query = async (sql: string) => {
            const q = sql.replace(/\s+/g, ' ');
            if (/FROM post_insights/.test(q)) return { rows: POSTS };
            if (/DISTINCT ON \(platform\)/.test(q)) return { rows: [{ platform: 'instagram', followers: 8412 }] };
            if (/FROM account_insights_daily/.test(q)) return { rows: DAYS };
            if (/FROM creator_profiles/.test(q)) return { rows: rows.profile ? [{ profile: rows.profile, version: 1, activated_at: null }] : [] };
            if (/SELECT last_sync FROM growth_settings/.test(q)) return { rows: [] };
            if (/FROM growth_settings/.test(q)) return { rows: [{ ...rows.growth }] };
            if (/FROM studio_settings/.test(q)) return { rows: [{ ...rows.studio }] };
            return { rows: [] };
        };
    };

    it('coachSystemPrompt: Arabic is his; English is the control\'s', () => {
        matchGolden('growth.coach-system.ar', coachSystemPrompt('ar'));
        matchGolden('growth.coach-system.en', coachSystemPrompt('en'), 'control');
        matchGoldenJson('growth.coach-schema', COACH_SCHEMA);
    });

    for (const [via, rows] of PATHS) it(`suggestKeywords: the system prompt and the turn it sends for his Growth settings and language (${via})`, async () => {
        mockDatabase(rows);
        const requests: ModelRequest[] = [];
        const call: CallModel = async (req) => {
            requests.push(req);
            return { keywords: [{ term: 'هندسة البرومبت', why: 'يبحث عنها المبتدئون' }], hashtags: ['#برومبت'] };
        };
        const out = await suggestKeywords('creator', { topic: 'هندسة البرومبت للمبتدئين' }, { callModel: call });
        assert.equal(out.language, 'ar');
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.system, keywordsSystemPrompt('ar'), 'the language comes from his voice.language');
        matchGolden('growth.keywords-system.ar', requests[0]!.system);
        matchGolden('growth.keywords-user.elamir', requests[0]!.turns[0]!.text);
        matchGoldenJson('growth.keywords-schema', KEYWORDS_SCHEMA);
    });

    for (const [via, rows] of PATHS) it(`runCoach: the system prompt and the numbers it sends for his Growth settings, timezone and language (${via})`, async () => {
        mockDatabase(rows);
        const requests: ModelRequest[] = [];
        const call: CallModel = async (req) => {
            requests.push(req);
            return { summary: 'ملخص', actions: [{ title: 'اقطع المقدمة', why: '٣ ثوانٍ', how: 'ابدأ بالنتيجة', effort: 'low', impact: 'high' }] };
        };
        const out = await runCoach('creator', { callModel: call, now: NOW });
        assert.equal(out.language, 'ar');
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.system, coachSystemPrompt('ar'), 'the language comes from his voice.language');
        matchGolden('growth.coach-user.elamir', requests[0]!.turns[0]!.text);
    });
});

// ─── The campaigns screen ───────────────────────────────────────────────────────────────────

describe('Campaign golden seeds', () => {
    /**
     * The REAL shipped file, run in a bare context. It only declares CampaignsPage and registers its
     * actions; the stubs are what `showBulkImportModal` touches on the way to filling `pendingImport`
     * (the modal markup is not pinned: it is chrome, and `showModal` swallows it).
     */
    const loadCampaignsPage = (): vm.Context => {
        const file = new URL('../../../dashboard/js/pages/campaigns.js', import.meta.url);
        const ctx = vm.createContext({
            UI: { registerActions: () => {}, showModal: () => {}, formatNumber: (n: unknown) => String(n), button: () => '' },
            html: Object.assign(() => '', { raw: (s: unknown) => s }),
            t: (key: string) => key,
        });
        vm.runInContext(readFileSync(file, 'utf8'), ctx, { filename: 'dashboard/js/pages/campaigns.js' });
        return ctx;
    };
    // Serialised inside the context, so what comes out belongs to this realm.
    const inside = (ctx: vm.Context, expression: string): any => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, ctx));

    it('COURSE_MAPPINGS: the DM and replies the bulk import seeds for his nine courses', () => {
        const mappings = inside(loadCampaignsPage(), 'CampaignsPage.COURSE_MAPPINGS');
        assert.equal(Object.keys(mappings).length, 9);
        matchGoldenJson('campaigns.course-mappings', mappings);
    });

    it('showBulkImportModal: what each imported course is seeded with: the first mapping its name contains, else the Arabic fallback', () => {
        const ctx = loadCampaignsPage();
        const course = (id: number, name: string) => ({ id, name, url: `https://www.udemy.com/course/golden-${id}/?couponCode=GOLDEN${id}`, code: `GOLDEN${id}`, redemptions: id * 7 });
        // One per mapping key, in the order of the table, named as the courses are. 'Problem Solving - with C#'
        // contains two keys ('problem solving' and 'c#'): the first in table order wins. The last has none.
        const courses = [
            course(1, 'Agentic AI: الدليل العملي لبناء ما تحتاجه بالذكاء الاصطناعي'),
            course(2, 'GoLang Course: Learn Go in Arabic'),
            course(3, 'Swift Programming Language | in Arabic'),
            course(4, 'CSS3 For Beginners [In Arabic]'),
            course(5, 'HTML5 For Beginners [In Arabic]'),
            course(6, 'Problem Solving - with C# [in Arabic]'),
            course(7, 'Java for Beginners [in Arabic]'),
            course(8, 'Python For Beginners [in Arabic]'),
            course(9, 'C# For Beginners [in Arabic]'),
            course(10, 'Rust Systems Programming [in Arabic] - Part 1'),
        ];
        vm.runInContext(`CampaignsPage.showBulkImportModal(${JSON.stringify(courses)})`, ctx);
        const rows = inside(ctx, 'CampaignsPage.pendingImport');
        assert.equal(rows.length, courses.length);
        assert.deepEqual(rows.map((r: { matched: boolean }) => r.matched), [...Array(9).fill(true), false]);
        matchGoldenJson('campaigns.import-rows', rows);
    });
});

// ─── The net itself ─────────────────────────────────────────────────────────────────────────

describe('the owner\'s profile survives storage', () => {
    it('serialised and reordered like jsonb, it reads back as it was described, with nothing repaired', () => {
        for (const [settings, growth] of [[ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH], [ELAMIR_SETTINGS, ELAMIR_GROWTH], [ENGLISH_SETTINGS, undefined]] as const) {
            const described = profileFromLegacy(settings, growth);
            const stored = throughJsonb(described);
            assert.notEqual(JSON.stringify(stored), JSON.stringify(described), 'the keys really were reordered');
            const out = upgradeProfile(stored);
            assert.deepStrictEqual(out.profile, described);
            assert.deepStrictEqual(out.repaired, []);
        }
    });
});

describe('the golden files', () => {
    // A name filter skips tests, so their files would look unchecked.
    const filtered = [...process.execArgv, ...process.argv].some((a) => /test-name-pattern|test-skip-pattern|test-only/.test(a));
    it('none on disk is left unchecked by this suite, so deleting an assertion cannot silently drop coverage', { skip: filtered }, () => {
        assert.deepEqual(uncheckedGoldens(), []);
    });
});
