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
 * Path (c), "through the real readers" (P4): the owner's row (its profile-owned fields scrambled) and his stored profile
 * are put in a stand-in database, and the builders are handed what the real `getStudioSettings` returns; the Growth
 * builders run their own readers (`getGrowthSettings`, `getStudioSettings` inside the coach) against the same stored
 * rows and profile (`growthSurface`'s `storedProfile`, the one opt-in the parity script never uses). Path (b) proves the
 * view; this proves the readers return it, over the statements they send, jsonb's key order included. The same goldens
 * again: dropping the overlay from a reader fails here, and nowhere that reads a fixture.
 *
 * The builder calls for everything that reads a tenant's settings live in `promptSurface.ts`, the list the live parity
 * script (`scripts/prompt-parity.mts`, docs/onboarding/05 §4) hashes for a real tenant too: the goldens and the live
 * check cannot be calling different builders. This file says what each entry must equal, and holds the constants.
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
import { describe, it, type TestContext } from 'node:test';
import vm from 'node:vm';
import type { GrowthSettings } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { AI_DISCLOSURE_LINE } from '../../webhook/meta-payload.js';
import { RESPONSE_SCHEMA, STARTER_PERSONA } from '../ai.js';
import { COACH_SCHEMA, coachSystemPrompt } from '../growth/coach.js';
import { KEYWORDS_SCHEMA } from '../growth/keywords.js';
import { analystUserPrompt, LESSONS_SCHEMA } from '../monteur/analyst.js';
import { ASK_POOL, COPY_SCHEMA } from '../monteur/copy.js';
import { editorSchema, HUMAN_TOUCHES_PROMPT } from '../monteur/editor.js';
import { PICK_SCHEMA } from '../monteur/pick.js';
import { DRAFT_SCHEMA, PLAN_SCHEMA } from '../studio/generate.js';
import { WRITE_SCHEMA, writeSystemPrompt } from '../studio/infographicSpec.js';
import { buildPlanCatalog, LANGUAGES, planUserPrompt } from '../studio/prompts.js';
import type { StudioSettings } from '../studio/settingsTypes.js';
import {
    ELAMIR_AGENT, ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS, ELAMIR_SETTINGS, ENGLISH_SETTINGS,
    GOLDEN_LESSON, GOLDEN_LESSONS, GOLDEN_REELS, GOLDEN_UNINDEXED_LESSON,
} from '../studio/testFixtures.js';
import { videoResource } from '../youtube.js';
import { getStudioSettings } from '../studio/settings.js';
import { matchGolden, matchGoldenJson, uncheckedGoldens, type GoldenSet } from './golden.js';
import { upgradeProfile } from './defaults.js';
import { profileFromLegacy } from './legacy.js';
import {
    dmFallbackSurface, dmInstructionSurface, growthSurface, infographicSurface, SAY, studioSurface, type GrowthRows, type SurfaceEntry,
} from './promptSurface.js';
import { emptyState, installProfileDb, OWNER, studioRow } from './testDb.js';
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
 * Path (c): what the real `getStudioSettings` returns for a tenant whose profile is stored. The stored row holds junk in
 * every profile-owned field (nothing may survive from it), the profile is `profileFromLegacy` as the database holds it.
 */
async function throughTheReader(settings: StudioSettings, growth?: GrowthSettings): Promise<StudioSettings> {
    const state = emptyState();
    state.studio.set(OWNER, studioRow(scramble(settings, STUDIO_PROFILE_PATHS)));
    state.profiles.set(OWNER, { profile: throughJsonb(profileFromLegacy(settings, growth)), version: 1, activated_at: null, updated_by: null });
    const db = installProfileDb(state);
    const previousSink = setLogSink(() => {});
    try {
        const read = await getStudioSettings(OWNER);
        assert.ok(!JSON.stringify(read).includes('JUNK:'), 'nothing survives from the stale row that the profile owns');
        assert.equal(db.ran(/FROM creator_profiles/).length, 1, 'the reader asked for the stored profile');
        return read;
    } finally {
        setLogSink(previousSink);
        db.restore();
    }
}

type Variant = {
    slug: 'elamir' | 'seed' | 'english'; settings: StudioSettings; set: GoldenSet; lang: 'ar' | 'en';
    /** How the builder is handed the settings: as they are, as the owner's profile gives them back, or as the real reader returns them. */
    via: 'today' | 'profile' | 'readers';
};
const FIXTURES = [
    { slug: 'elamir', settings: ELAMIR_SETTINGS, set: 'elamir', lang: 'ar', owner: true },
    { slug: 'seed', settings: ELAMIR_SEED_SETTINGS, set: 'elamir', lang: 'ar', owner: true },
    { slug: 'english', settings: ENGLISH_SETTINGS, set: 'control', lang: 'en', owner: false },
] as const;
/** What the real reader returns for each fixture (path (c)). Read once, before any test: each swaps the one shared pool for a stand-in and puts it back, so one at a time. */
const READ = {} as Record<(typeof FIXTURES)[number]['slug'], StudioSettings>;
for (const f of FIXTURES) READ[f.slug] = await throughTheReader(f.settings, f.owner ? ELAMIR_GROWTH : undefined);
/** Each fixture three times, into the same golden: as it is, through the profile, and through the real reader. */
const VARIANTS: readonly Variant[] = FIXTURES.flatMap((f): Variant[] => [
    { slug: f.slug, settings: f.settings, set: f.set, lang: f.lang, via: 'today' },
    { slug: f.slug, settings: through(f.settings, f.owner), set: f.set, lang: f.lang, via: 'profile' },
    { slug: f.slug, settings: READ[f.slug], set: f.set, lang: f.lang, via: 'readers' },
]);
const describeVariant = (v: Variant): string => `${v.slug} settings${v.via === 'profile' ? ', through the profile' : v.via === 'readers' ? ', through the real readers' : ''}`;
/** The Studio and Monteur builders' output for a variant, built once: the two sections below each check their half. */
const surfaces = new Map<Variant, Promise<SurfaceEntry[]>>();
const studioEntries = (v: Variant, prefixes: readonly string[]): Promise<SurfaceEntry[]> => {
    if (!surfaces.has(v)) surfaces.set(v, studioSurface(v.settings, { lang: v.lang, slug: v.slug, set: v.set }));
    return surfaces.get(v)!.then((all) => all.filter((e) => prefixes.some((p) => e.name.startsWith(p))));
};
/**
 * Every builder that depends on a tenant's settings is called from `promptSurface.ts`, which the live parity script
 * (`scripts/prompt-parity.mts`) calls too, so the two cannot disagree about what a builder is handed. An entry is
 * named as its golden file is: `<name>.<fixture>` for the owner's two fixtures (in his set) and the English control
 * (in its own).
 */
const matchEntry = (e: SurfaceEntry): void => {
    if (e.error !== undefined) throw new Error(`${e.name}: the builder threw: ${e.error}`);
    if (e.kind === 'text') matchGolden(e.name, e.value as string, e.set);
    else matchGoldenJson(e.name, e.value, e.set);
};
/** Each entry of a surface as a test of its own, so one moved prompt names itself instead of hiding the ones after it. */
const matchEach = async (t: TestContext, entries: readonly SurfaceEntry[]): Promise<void> => {
    assert.ok(entries.length > 0, 'a surface with no entries pins nothing');
    for (const e of entries) await t.test(e.name, () => matchEntry(e));
};

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
    it('dmSystemInstruction: his persona and knowledge base inside the fixed rules', async (t) => {
        await matchEach(t, dmInstructionSurface(ELAMIR_AGENT));
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

    for (const [via, owner] of [['today', ELAMIR_SETTINGS], ['through the profile', through(ELAMIR_SETTINGS, true)], ['through the real readers', READ.elamir]] as const) it(`dmFallbackReply: the public reply that replaces an undeliverable DM, every variant (${via})`, async (t) => {
        await matchEach(t, dmFallbackSurface(owner));
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
        it(`the writer's prompts, CTA lines, DM, captions and carousel payload (${describeVariant(v)})`, async (t) => {
            await matchEach(t, await studioEntries(v, ['studio.', 'captions.']));
        });
    }
});

// ─── The Monteur ────────────────────────────────────────────────────────────────────────────

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
        it(`pick, copy, Editor, Analyst and render payload (${describeVariant(v)})`, async (t) => {
            await matchEach(t, await studioEntries(v, ['monteur.']));
        });
    }
});

// ─── Infographics ───────────────────────────────────────────────────────────────────────────

describe('Infographic golden prompts', () => {
    it('writeSystemPrompt: Arabic (فصحى) is his; English is the control\'s', () => {
        matchGolden('infographic.system.ar', writeSystemPrompt('ar'));
        matchGolden('infographic.system.en', writeSystemPrompt('en'), 'control');
    });

    for (const [via, seed] of [['today', ELAMIR_SEED_SETTINGS], ['through the profile', through(ELAMIR_SEED_SETTINGS, true)], ['through the real readers', READ.seed]] as const) {
        it(`renderPayload and payloadBrand: the job the Mac gets in write mode and the brand it draws, from his seed settings (${via})`, async (t) => {
            await matchEach(t, infographicSurface(seed, { slug: 'seed' }));
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
    /**
     * His rows as the Growth readers and the Studio settings behind `tenantLanguage` read them: as they are
     * (path a), or as the profile gives them back from a scrambled row (path b).
     */
    const TODAY: GrowthRows = { growth: ELAMIR_GROWTH, studio: ELAMIR_SEED_SETTINGS };
    const profile = storedProfile(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);
    const THROUGH_THE_PROFILE: GrowthRows = {
        growth: growthView(scramble(ELAMIR_GROWTH, GROWTH_PROFILE_PATHS), profile),
        studio: studioView(scramble(ELAMIR_SEED_SETTINGS, STUDIO_PROFILE_PATHS), profile),
    };
    // Path (c): the database holds the scrambled rows and the stored profile; the real readers do the overlay.
    const THROUGH_THE_REAL_READERS: GrowthRows = {
        growth: scramble(ELAMIR_GROWTH, GROWTH_PROFILE_PATHS),
        studio: scramble(ELAMIR_SEED_SETTINGS, STUDIO_PROFILE_PATHS),
    };
    const STORED = throughJsonb(profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH));
    const PATHS = [
        ['today', TODAY, undefined], ['through the profile', THROUGH_THE_PROFILE, undefined], ['through the real readers', THROUGH_THE_REAL_READERS, STORED],
    ] as const;

    it('coachSystemPrompt: Arabic is his; English is the control\'s', () => {
        matchGolden('growth.coach-system.ar', coachSystemPrompt('ar'));
        matchGolden('growth.coach-system.en', coachSystemPrompt('en'), 'control');
        matchGoldenJson('growth.coach-schema', COACH_SCHEMA);
        matchGoldenJson('growth.keywords-schema', KEYWORDS_SCHEMA);
    });

    for (const [via, rows, storedProfile] of PATHS) it(`the keyword finder and the coach: the system prompts and the turns they send for his Growth settings, timezone and language (${via})`, async (t) => {
        const entries = await growthSurface(rows, { slug: 'elamir', storedProfile });
        // The language comes from his voice.language: each system prompt is named for the one it was written in.
        assert.deepEqual(entries.map((e) => e.name), ['growth.keywords-system.ar', 'growth.keywords-user.elamir', 'growth.coach-system.ar', 'growth.coach-user.elamir']);
        await matchEach(t, entries);
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
