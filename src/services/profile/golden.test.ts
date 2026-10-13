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
 * The DM and comment surfaces (P8) are written from a profile context: the language and register the surface speaks and the
 * kind of thing the creator sells. The owner's bytes are pinned along the four ways the code can come by that context: the
 * legacy assumptions (what the code said before P8, and what it falls back to when a profile cannot be read), the context cut
 * from his stored profile, what the real `profileContext` reads from a stand-in database that holds it, and what
 * `profileContextOrLegacy` answers when that database fails. All four must write the same bytes into the same goldens.
 *
 * The Studio writer (P9) is written from the `carousel` context of the profile (the language and register it writes in, the kind of
 * creator and what they sell) and shows the owner his three built-in carousels until they are copied into his row (P14). Its
 * goldens are pinned the same ways, with `studioWording` itself as the fourth: his bytes are what the new code makes of his
 * context, and an unreadable profile is his legacy context, not a failure.
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
import { COACH_SCHEMA, coachSystemPrompt } from '../growth/coach.js';
import { KEYWORDS_SCHEMA } from '../growth/keywords.js';
import { analystUserPrompt, LESSONS_SCHEMA } from '../monteur/analyst.js';
import { ASK_POOL, COPY_SCHEMA } from '../monteur/copy.js';
import { reelKitsFor, reelKitsFromContexts } from '../monteur/copyKits.js';
import { editorSchema, humanTouchesPrompt } from '../monteur/editor.js';
import { PRONOUN_KITS } from '../monteur/editorKits.js';
import { PICK_SCHEMA } from '../monteur/pick.js';
import { DRAFT_SCHEMA, PLAN_SCHEMA } from '../studio/generate.js';
import { WRITE_SCHEMA, writeSystemPrompt } from '../studio/infographicSpec.js';
import { buildPlanCatalog, LANGUAGES, planUserPrompt } from '../studio/prompts.js';
import type { StudioSettings } from '../studio/settingsTypes.js';
import {
    ELAMIR_AGENT, ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS, ELAMIR_SETTINGS, ENGLISH_SETTINGS,
    GOLDEN_LESSON, GOLDEN_LESSONS, GOLDEN_REELS, GOLDEN_UNINDEXED_LESSON,
} from '../studio/testFixtures.js';
import { videoResource, youtubeCategoryId } from '../youtube.js';
import { youtubeCategoryFor } from '../youtubePublish.js';
import { studioWording } from '../studio/drafts.js';
import { draftSchema } from '../studio/generate.js';
import type { StudioWording } from '../studio/prompts.js';
import { getStudioSettings } from '../studio/settings.js';
import { campaignSeeds, legacyCampaignSeeds } from './campaignSeeds.js';
import { matchGolden, matchGoldenJson, uncheckedGoldens, type GoldenSet } from './golden.js';
import { contextFor, legacyContext, profileContext, profileContextOrLegacy, type ProfileContext } from './context.js';
import { upgradeProfile } from './defaults.js';
import { profileFromLegacy } from './legacy.js';
import { LEGACY_COURSE_MAPPINGS } from './legacyCourseMappings.js';
import {
    dmContextSurface, dmFallbackSurface, dmInstructionSurface, growthSurface, infographicSurface, SAY, studioSurface, type GrowthRows, type SurfaceEntry,
} from './promptSurface.js';
import { planOwnerOffers } from './ownerOffers.js';
import { emptyState, installProfileDb, OTHER, OWNER, setPlatformOwner, studioRow } from './testDb.js';
import { inside, loadCampaignsPage, scramble, throughJsonb } from './testSupport.js';
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
async function throughTheReader(settings: StudioSettings, growth?: GrowthSettings): Promise<{ settings: StudioSettings; editor: ProfileContext<'clip_edit'> }> {
    const state = emptyState();
    state.studio.set(OWNER, studioRow(scramble(settings, STUDIO_PROFILE_PATHS)));
    state.profiles.set(OWNER, { profile: throughJsonb(profileFromLegacy(settings, growth)), version: 1, activated_at: null, updated_by: null });
    const db = installProfileDb(state);
    const previousSink = setLogSink(() => {});
    try {
        const read = await getStudioSettings(OWNER);
        assert.ok(!JSON.stringify(read).includes('JUNK:'), 'nothing survives from the stale row that the profile owns');
        assert.equal(db.ran(/FROM creator_profiles/).length, 1, 'the reader asked for the stored profile');
        // The Editor asks for the same stored profile through `profileContext`, the call `sweep.ts` makes (P10).
        return { settings: read, editor: await profileContext(OWNER, 'clip_edit') };
    } finally {
        setLogSink(previousSink);
        db.restore();
    }
}

/**
 * Path (c) for the infographic writer (P12): the context the real `profileContext` returns for a tenant whose profile is
 * stored, with the stale settings row beside it. The writer reads its role, domain and register from this, never from the row.
 */
async function infographicContextThroughTheReader(settings: StudioSettings, growth?: GrowthSettings): Promise<ProfileContext<'infographic'>> {
    const state = emptyState();
    state.studio.set(OWNER, studioRow(scramble(settings, STUDIO_PROFILE_PATHS)));
    state.profiles.set(OWNER, { profile: throughJsonb(profileFromLegacy(settings, growth)), version: 1, activated_at: null, updated_by: null });
    const db = installProfileDb(state);
    const previousSink = setLogSink(() => {});
    try {
        const ctx = await profileContext(OWNER, 'infographic');
        assert.equal(db.ran(/FROM creator_profiles/).length, 1, 'the reader asked for the stored profile');
        return ctx;
    } finally {
        setLogSink(previousSink);
        db.restore();
    }
}

/** A tenant's context for `purpose`, as `profileContext` reads it from a stand-in database that holds `stored` (or holds nothing, or fails). */
async function contextFromTheDatabase<P extends 'dm' | 'comment_reply'>(purpose: P, stored: CreatorProfile | null, fail = false): Promise<ProfileContext<P>> {
    const state = emptyState();
    if (stored) state.profiles.set(OWNER, { profile: throughJsonb(stored), version: 1, activated_at: null, updated_by: null });
    const db = installProfileDb(state);
    if (fail) { db.failOn = /FROM creator_profiles/; db.failWith = new Error('connection refused'); setPlatformOwner(db, OWNER); }
    const previousSink = setLogSink(() => {});
    try {
        return fail ? await profileContextOrLegacy(OWNER, purpose) : await profileContext(OWNER, purpose);
    } finally {
        setLogSink(previousSink);
        db.restore();
    }
}

/**
 * The owner's DM and comment contexts, the four ways the code comes by one. Each is a different route to the same facts
 * (Gulf Arabic, courses), and each must write the bytes in the goldens: the new code path IS the proof of the old text.
 */
const OWNER_PROFILE = storedProfile(ELAMIR_SETTINGS, ELAMIR_GROWTH);
const OWNER_CONTEXTS = {
    'the legacy assumptions': { dm: legacyContext('dm'), comments: legacyContext('comment_reply') },
    'his stored profile': { dm: contextFor(OWNER_PROFILE, 'dm', 1), comments: contextFor(OWNER_PROFILE, 'comment_reply', 1) },
    'the real profileContext': { dm: await contextFromTheDatabase('dm', OWNER_PROFILE), comments: await contextFromTheDatabase('comment_reply', OWNER_PROFILE) },
    'a profile that cannot be read': { dm: await contextFromTheDatabase('dm', null, true), comments: await contextFromTheDatabase('comment_reply', null, true) },
} as const;

/**
 * `body` run against a stand-in database that holds `stored` as the owner's profile, or nothing, or fails every profile read as a
 * database that is down would (the owner is the platform owner, so he is answered in his own wording). The sink is silenced and
 * the pool put back.
 */
async function withOwnerProfile<T>(stored: CreatorProfile | null, fail: boolean, body: () => Promise<T>): Promise<T> {
    const state = emptyState();
    if (stored) state.profiles.set(OWNER, { profile: throughJsonb(stored), version: 1, activated_at: null, updated_by: null });
    const db = installProfileDb(state);
    if (fail) { db.failOn = /FROM creator_profiles/; db.failWith = new Error('connection refused'); setPlatformOwner(db, OWNER); }
    const previousSink = setLogSink(() => {});
    try {
        return await body();
    } finally {
        setLogSink(previousSink);
        db.restore();
    }
}

/**
 * The owner's pick and copy kits (P11) and his YouTube category, the four ways the code comes by them: the legacy assumptions, the
 * contexts cut from his stored profile, what the sweep's `reelKitsFor` (and the publisher's `youtubeCategoryFor`) read from a
 * stand-in database that holds it, and what they answer when that database fails. Each is a different route to the same facts
 * (Gulf Arabic, the tech domain, an educator), and each must write the bytes in the goldens.
 */
const OWNER_REELS = {
    'the legacy assumptions': { kits: reelKitsFromContexts(legacyContext('clip_pick'), legacyContext('clip_copy')), category: youtubeCategoryId(legacyContext('clip_copy').who.kind) },
    'his stored profile': {
        kits: reelKitsFromContexts(contextFor(OWNER_PROFILE, 'clip_pick', 1), contextFor(OWNER_PROFILE, 'clip_copy', 1)),
        category: youtubeCategoryId(contextFor(OWNER_PROFILE, 'clip_copy', 1).who.kind),
    },
    'the real reelKitsFor and youtubeCategoryFor': await withOwnerProfile(OWNER_PROFILE, false, async () => ({ kits: await reelKitsFor(OWNER), category: await youtubeCategoryFor(OWNER) })),
    'a profile that cannot be read': await withOwnerProfile(null, true, async () => ({ kits: await reelKitsFor(OWNER), category: await youtubeCategoryFor(OWNER) })),
} as const;

type Variant = {
    slug: 'elamir' | 'seed' | 'english'; settings: StudioSettings; set: GoldenSet; lang: 'ar' | 'en';
    /**
     * How the builder is handed the settings: as they are, as the owner's profile gives them back, or as the real reader returns them.
     * `unreadable` is today's settings with the contexts the owner gets when his profile cannot be read (the owner's fixtures only).
     */
    via: 'today' | 'profile' | 'readers' | 'unreadable';
    /**
     * The context the Editor's prompt is written from (P10), reached the same way: described from the rows (none given:
     * `studioSurface` makes it), from the stored profile, or by the real `profileContext`. The same for every fixture: the English
     * control's Editor golden is what its profile (`profileFromLegacy(ENGLISH_SETTINGS)`: English labels, the legacy man, the tech
     * tools) selects, not the text of a profile that cannot be read (`LEGACY_EDITOR_KIT`, which has Arabic labels).
     */
    editor: ProfileContext<'clip_edit'> | undefined;
    /** What the Studio's writer is told about the creator (P9), by the same route: the `carousel` context and whether the built-ins are shown. */
    wording: StudioWording;
};
const FIXTURES = [
    { slug: 'elamir', settings: ELAMIR_SETTINGS, set: 'elamir', lang: 'ar', owner: true },
    { slug: 'seed', settings: ELAMIR_SEED_SETTINGS, set: 'elamir', lang: 'ar', owner: true },
    { slug: 'english', settings: ENGLISH_SETTINGS, set: 'control', lang: 'en', owner: false },
] as const;
/** What the real reader returns for each fixture (path (c)). Read once, before any test: each swaps the one shared pool for a stand-in and puts it back, so one at a time. */
const READ = {} as Record<(typeof FIXTURES)[number]['slug'], { settings: StudioSettings; editor: ProfileContext<'clip_edit'> }>;
for (const f of FIXTURES) READ[f.slug] = await throughTheReader(f.settings, f.owner ? ELAMIR_GROWTH : undefined);

/**
 * The Studio writer's wording for a fixture, the four ways the code can come by it. Only the owner is shown the built-in carousels
 * (`builtInExamples`): the English control is a tenant that is not him, so its prompt has no examples section.
 *   today        described from the rows: `profileFromLegacy` cut to the `carousel` context (the legacy assumptions);
 *   profile      cut from the profile as it comes back from storage;
 *   readers      what the real `studioWording` returns from a stand-in database holding that profile, and who the owner is;
 *   unreadable   the same, when the profile cannot be read: for the owner it is his legacy context.
 */
const wordingOf = (profile: CreatorProfile, version: number | null, owner: boolean): StudioWording => ({ ...contextFor(profile, 'carousel', version), builtInExamples: owner });

async function wordingThroughTheReader(settings: StudioSettings, growth: GrowthSettings | undefined, owner: boolean, unreadable = false): Promise<StudioWording> {
    const state = emptyState();
    state.studio.set(OWNER, studioRow(scramble(settings, STUDIO_PROFILE_PATHS)));
    if (!unreadable) state.profiles.set(OWNER, { profile: throughJsonb(profileFromLegacy(settings, growth)), version: 1, activated_at: null, updated_by: null });
    const db = installProfileDb(state);
    // The platform owner is the lookup's answer: this tenant for the owner's fixtures, somebody else for the control.
    setPlatformOwner(db, owner ? OWNER : OTHER);
    if (unreadable) { db.failOn = /FROM creator_profiles/; db.failWith = new Error('connection refused'); }
    const previousSink = setLogSink(() => {});
    try {
        return await studioWording(OWNER);
    } finally {
        setLogSink(previousSink);
        db.restore();
    }
}
/**
 * His context on the infographic surface (tech educator, tech, فصحى), reached the three ways: described from his rows (today, no
 * stored profile), from his stored profile, and from the real `profileContext`. The writer is handed it by `infographicContext`,
 * so each way must write the same bytes into the same goldens.
 */
const INFOGRAPHIC_CONTEXT = {
    today: contextFor(profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH), 'infographic', null),
    'through the profile': contextFor(storedProfile(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH), 'infographic', 1),
    'through the real readers': await infographicContextThroughTheReader(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH),
} as const;
/** Each fixture three times, into the same golden: as it is, through the profile, and through the real reader. */
const GROWTH_OF = (owner: boolean): GrowthSettings | undefined => (owner ? ELAMIR_GROWTH : undefined);
const VARIANTS: Variant[] = [];
// One at a time: each reader swaps the one shared pool for a stand-in, and the platform owner is cached for a moment.
for (const f of FIXTURES) {
    VARIANTS.push(
        { slug: f.slug, settings: f.settings, set: f.set, lang: f.lang, via: 'today', editor: undefined, wording: wordingOf(profileFromLegacy(f.settings, GROWTH_OF(f.owner)), null, f.owner) },
        {
            slug: f.slug, settings: through(f.settings, f.owner), set: f.set, lang: f.lang, via: 'profile',
            editor: contextFor(storedProfile(f.settings, GROWTH_OF(f.owner)), 'clip_edit', 1), wording: wordingOf(storedProfile(f.settings, GROWTH_OF(f.owner)), 1, f.owner),
        },
        {
            slug: f.slug, settings: READ[f.slug].settings, set: f.set, lang: f.lang, via: 'readers',
            editor: READ[f.slug].editor, wording: await wordingThroughTheReader(f.settings, GROWTH_OF(f.owner), f.owner),
        },
    );
    // A profile that cannot be read is answered by who asks: the owner keeps his wording (`editorKitFor`, `studioWording`: his legacy
    // contexts), only his fixtures, and only the Editor's and the Studio writer's entries change. (Any other tenant gets an error: studioWriter.test.ts.)
    if (f.owner) {
        VARIANTS.push({
            slug: f.slug, settings: f.settings, set: f.set, lang: f.lang, via: 'unreadable',
            editor: legacyContext('clip_edit'), wording: await wordingThroughTheReader(f.settings, GROWTH_OF(true), true, true),
        });
    }
}
const describeVariant = (v: Variant): string => `${v.slug} settings${v.via === 'profile' ? ', through the profile' : v.via === 'readers' ? ', through the real readers' : v.via === 'unreadable' ? ', a profile that cannot be read' : ''}`;
/** The Studio and Monteur builders' output for a variant, built once: the two sections below each check their half. */
const surfaces = new Map<Variant, Promise<SurfaceEntry[]>>();
const studioEntries = (v: Variant, prefixes: readonly string[]): Promise<SurfaceEntry[]> => {
    if (!surfaces.has(v)) surfaces.set(v, studioSurface(v.settings, { lang: v.lang, slug: v.slug, set: v.set, editor: v.editor, carousel: v.wording }));
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
    for (const [via, ctx] of Object.entries(OWNER_CONTEXTS)) {
        it(`dmSystemInstruction, dmResponseSchema, disclosureLine and starterPersona: his persona and knowledge base inside the fixed rules, the schema, the first line and the starter persona (from ${via})`, async (t) => {
            await matchEach(t, [...dmInstructionSurface(ELAMIR_AGENT, ctx.dm), ...dmContextSurface(ctx.dm)]);
        });
    }

    it('AI_DISCLOSURE_LINE: the Arabic line, which is what applyDisclosure says when it is handed none', () => {
        matchGolden('dm.disclosure-line', AI_DISCLOSURE_LINE);
    });

    for (const [via, owner, contexts] of [
        ['today', ELAMIR_SETTINGS, OWNER_CONTEXTS['the legacy assumptions']],
        ['through the profile', through(ELAMIR_SETTINGS, true), OWNER_CONTEXTS['his stored profile']],
        ['through the real readers', READ.elamir.settings, OWNER_CONTEXTS['the real profileContext']],
        ['a profile that cannot be read', ELAMIR_SETTINGS, OWNER_CONTEXTS['a profile that cannot be read']],
    ] as const) it(`dmFallbackReply: the public reply that replaces an undeliverable DM, every variant (${via})`, async (t) => {
        await matchEach(t, dmFallbackSurface(owner, contexts.comments));
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

    for (const v of VARIANTS.filter((x) => x.slug !== 'english')) {
        it(`draftSchema: the schema the writer is handed for the owner is the golden one, from his context (${describeVariant(v)})`, () => {
            matchGoldenJson('studio.draft-schema', draftSchema(v.wording));
        });
    }

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
    it('ASK_POOL: the built-in asks, the Gulf register\'s his (the file is named for his language) and English the control\'s', () => {
        matchGoldenJson('monteur.copy.ask-pool.ar', ASK_POOL.gulf);
        matchGoldenJson('monteur.copy.ask-pool.en', ASK_POOL.en, 'control');
    });

    it('the schemas the pick, the copy and the Analyst answer with, and the Editor\'s with touches on and off', () => {
        matchGoldenJson('monteur.pick-schema', PICK_SCHEMA);
        matchGoldenJson('monteur.copy-schema', COPY_SCHEMA);
        matchGoldenJson('monteur.analyst-schema', LESSONS_SCHEMA);
        matchGoldenJson('monteur.editor-schema.human-on', editorSchema(true));
        matchGoldenJson('monteur.editor-schema.human-off', editorSchema(false));
    });

    it('humanTouchesPrompt: the Editor\'s human-touch rules, for a man on camera (his)', () => {
        matchGolden('monteur.editor-human-touches', humanTouchesPrompt(PRONOUN_KITS.he));
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

    // The pick and the copy are written from the profile's contexts: his, however the code comes by them, is the text he always had.
    for (const [via, { kits }] of Object.entries(OWNER_REELS)) {
        it(`pick and copy: the pick's prompts, the copy's prompts and the clip copy, built from his kits (${via})`, async (t) => {
            const entries = await studioSurface(ELAMIR_SETTINGS, { lang: 'ar', slug: 'elamir', carousel: wordingOf(OWNER_PROFILE, 1, true), reelKits: kits });
            await matchEach(t, entries.filter((e) => e.name.startsWith('monteur.pick') || e.name.startsWith('monteur.copy')));
        });
    }
});

// ─── Infographics ───────────────────────────────────────────────────────────────────────────

describe('Infographic golden prompts', () => {
    for (const [via, ctx] of Object.entries(INFOGRAPHIC_CONTEXT)) {
        it(`writeSystemPrompt: Arabic (فصحى) is his; English is the control's (${via})`, () => {
            matchGolden('infographic.system.ar', writeSystemPrompt('ar', ctx));
            matchGolden('infographic.system.en', writeSystemPrompt('en', ctx), 'control');
        });
    }

    for (const [via, seed] of [['today', ELAMIR_SEED_SETTINGS], ['through the profile', through(ELAMIR_SEED_SETTINGS, true)], ['through the real readers', READ.seed.settings]] as const) {
        it(`renderPayload and payloadBrand: the job the Mac gets in write mode and the brand it draws, from his seed settings (${via})`, async (t) => {
            await matchEach(t, infographicSurface(seed, { slug: 'seed', ctx: INFOGRAPHIC_CONTEXT[via] }));
        });
    }

    it('WRITE_SCHEMA: what Claude answers an infographic with', () => {
        matchGoldenJson('infographic.write-schema', WRITE_SCHEMA);
    });
});

// ─── YouTube ────────────────────────────────────────────────────────────────────────────────

describe('YouTube golden payloads', () => {
    for (const [via, { category }] of Object.entries(OWNER_REELS)) {
        it(`videoResource: his uploads are categorised as Education, and declared not made for kids (${via})`, () => {
            matchGoldenJson('youtube.video-resource', videoResource({
                title: SAY.ar.copy.first_line, description: SAY.ar.copy.body, tags: ['ذكاء_اصطناعي', 'LMStudio'], privacy: 'public', language: 'ar', categoryId: category,
            }));
        });
    }
});

// ─── The Growth coach ───────────────────────────────────────────────────────────────────────

describe('Growth coach golden prompts', () => {
    /**
     * His rows as the Growth readers and the profile context behind `tenantLanguage` / `tenantTimezone` read them: as they are
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
     * The REAL shipped file, run in a bare context (testSupport.ts). It only declares CampaignsPage and registers its
     * actions; the stubs are what `showBulkImportModal` touches on the way to filling `pendingImport` (the modal markup is
     * not pinned: it is chrome, and `showModal` swallows it).
     */
    const page = loadCampaignsPage();

    it('LEGACY_COURSE_MAPPINGS: the DM and replies the bulk import seeded for his nine courses, now held on the server', () => {
        assert.equal(Object.keys(LEGACY_COURSE_MAPPINGS).length, 9);
        matchGoldenJson('campaigns.course-mappings', LEGACY_COURSE_MAPPINGS);
    });

    it('the dashboard carries none of them any more: the seeds come from the API', () => {
        assert.equal(inside(page, 'typeof CampaignsPage.COURSE_MAPPINGS'), 'undefined');
        assert.equal(inside(page, 'typeof CampaignsPage.seedFor'), 'function');
    });

    it('showBulkImportModal: what each imported course is seeded with: the first seed its name contains, else the Arabic fallback', () => {
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
        // The seeds are what the API hands the page. Both ways the owner can come by them must write the same rows into the
        // same golden: his nine as the fallback answers them (`legacyCampaignSeeds`, before his offers carry them), and the
        // seeds of the profile that has them (`campaignSeeds`, after `scripts/seed-owner-offers.mts`).
        const fromOffers = campaignSeeds(planOwnerOffers(profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH)).next);
        assert.deepStrictEqual(fromOffers, legacyCampaignSeeds(), 'his offers give the seeds his fallback gives, in the same order');
        for (const [label, seeds] of [['the legacy fallback', legacyCampaignSeeds()], ['his offers', fromOffers]] as const) {
            const ctx = loadCampaignsPage();
            vm.runInContext(`CampaignsPage.showBulkImportModal(${JSON.stringify(courses)}, ${JSON.stringify(seeds)})`, ctx);
            const rows = inside(ctx, 'CampaignsPage.pendingImport');
            assert.equal(rows.length, courses.length, label);
            assert.deepEqual(rows.map((r: { matched: boolean }) => r.matched), [...Array(9).fill(true), false], label);
            matchGoldenJson('campaigns.import-rows', rows);
        }
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
