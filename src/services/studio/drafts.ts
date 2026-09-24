/**
 * Carousel drafts (STUDIO.md §4): CRUD, and the generation and rendering around it.
 *
 *   generating ─(Gemini, in the request)→ rendering ─(worker)→ ready ─schedule→ scheduled
 *        └──────────────→ failed ←───────────────┘   └─edit→ rendering
 *
 * Generation runs inside the POST, synchronously, because it is one Gemini call with repair
 * rounds and the operator is waiting on the screen for it. If the invocation is cut off the row
 * stays `generating` forever; one older than ten minutes is therefore presented as failed.
 *
 * The generation module (generate.ts, rules.ts) is reached through `generation` so the tests
 * can stand in for Gemini. Nothing else here calls a model.
 */
import { pool } from '../../config/db.js';
import { queryRows } from '../../db/query.js';
import type {
    CarouselDraftRow, DraftAngle, DraftCampaign, DraftInput, LessonRow, Moment, RenderCarouselPayload, ShotSpec,
    StudioSettings,
} from '../../db/rows.js';
import { normalizeArabic } from '../../utils/arabic.js';
import { describeError, log } from '../../utils/log.js';
import type { Carousel, Slide } from './carouselTypes.js';
import {
    type Exec, isFiniteNumber, isPlainObject, problemsError, StudioError, unique, UUID_PATTERN, withTransaction,
} from './common.js';
import { generateDraft, planWeek, rewriteSlide, type GenContext } from './generate.js';
import { cancelRenders, deleteUnreferencedUploads, enqueueRender, type StudioJobView } from './jobs.js';
import { LESSON_COLUMNS, MOMENT_COLUMNS } from './lessons.js';
import { validateCarousel } from './rules.js';
import { getStudioSettings } from './settings.js';
import { nextFreeSlots } from './slots.js';

// ─── The generation seam ────────────────────────────────────────────────────────────────

export interface Generation {
    generateDraft: typeof generateDraft;
    rewriteSlide: typeof rewriteSlide;
    planWeek: typeof planWeek;
    validateCarousel: typeof validateCarousel;
}

const realGeneration: Generation = { generateDraft, rewriteSlide, planWeek, validateCarousel };
let generation: Generation = realGeneration;

/** Tests only: stand in for any of the four. `null` restores the real module. */
export function setGeneration(next: Partial<Generation> | null): void {
    generation = next ? { ...realGeneration, ...next } : realGeneration;
}

/**
 * The one call into rules.ts. The rules read the tenant's CTA lines and digit style (§10.3), so
 * the settings go with every call; keeping it to one place keeps a signature change to one line.
 */
function rulesProblems(carousel: Carousel, shots: Record<string, ShotSpec>, settings: StudioSettings): string[] {
    return generation.validateCarousel(carousel, new Set(Object.keys(shots)), settings);
}

// ─── Presentation ───────────────────────────────────────────────────────────────────────

/** A `generating` row older than this belongs to an invocation that was cut off. */
export const STALE_GENERATION_MS = 10 * 60 * 1000;
export const STALE_GENERATION_ERROR = 'Writing this draft never finished: the request was cut off. Try again.';

/** A draft as the API returns it (STUDIO.md §3 `Draft`). */
export type Draft = Omit<CarouselDraftRow, 'creator_id'>;

function isStaleGeneration(row: Pick<CarouselDraftRow, 'status' | 'updated_at'>, now: number): boolean {
    return row.status === 'generating' && now - new Date(row.updated_at).getTime() > STALE_GENERATION_MS;
}

/** The row as the API returns it. A stale `generating` reads as `failed`; the row is not rewritten. */
export function presentDraft(row: CarouselDraftRow, now: number = Date.now()): Draft {
    const { creator_id: _creator, ...draft } = row;
    if (isStaleGeneration(row, now)) return { ...draft, status: 'failed', error: draft.error ?? STALE_GENERATION_ERROR };
    return draft;
}

async function loadDraft(exec: Exec, creatorId: string, draftId: string, lock = false): Promise<CarouselDraftRow> {
    const { rows } = await exec.query<CarouselDraftRow>(
        `SELECT * FROM carousel_drafts WHERE id = $1 AND creator_id = $2${lock ? ' FOR UPDATE' : ''}`,
        [draftId, creatorId]
    );
    if (!rows[0]) throw new StudioError(404, 'No such draft.');
    return rows[0];
}

/** Refused once scheduled (STUDIO.md §4), and while the draft is still being written. */
function assertEditable(row: CarouselDraftRow, now: number = Date.now()): void {
    if (row.status === 'scheduled') {
        throw new StudioError(409, 'This draft is scheduled, so it can no longer be changed. Its posts are in Posts.');
    }
    if (row.status === 'generating' && !isStaleGeneration(row, now)) {
        throw new StudioError(409, 'This draft is still being written. Wait for it to finish.');
    }
}

function errorText(err: unknown): string {
    return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────────

export async function listDrafts(creatorId: string): Promise<Draft[]> {
    const rows = await queryRows<CarouselDraftRow>(
        'SELECT * FROM carousel_drafts WHERE creator_id = $1 ORDER BY created_at DESC', [creatorId]
    );
    const now = Date.now();
    return rows.map((row) => presentDraft(row, now));
}

/** The draft, and the lessons it is grounded in or takes shots from. */
export async function getDraft(
    creatorId: string, draftId: string
): Promise<{ draft: Draft; lessons: Pick<LessonRow, 'id' | 'lesson_no' | 'title'>[] }> {
    const row = await loadDraft(pool, creatorId, draftId);
    const ids = unique([
        ...(row.input?.lessonIds ?? []),
        ...Object.values(row.shots ?? {}).map((shot) => shot.lessonId),
    ].filter((id): id is string => typeof id === 'string' && UUID_PATTERN.test(id)));
    const lessons = ids.length
        ? await queryRows<Pick<LessonRow, 'id' | 'lesson_no' | 'title'>>(
            'SELECT id, lesson_no, title FROM course_lessons WHERE creator_id = $1 AND id = ANY($2::uuid[])',
            [creatorId, ids]
        )
        : [];
    return { draft: presentDraft(row), lessons };
}

// ─── Input validation ───────────────────────────────────────────────────────────────────

export const DRAFT_ANGLES: readonly DraftAngle[] = ['auto', 'tips', 'steps', 'mistakes', 'compare', 'prompt', 'overview'];
const HEX_COLOUR = /^#[0-9A-Fa-f]{6}$/;

/** One word: what a commenter types. Spaces would make it two triggers' worth of ambiguity. */
function isOneWord(value: string): boolean {
    return value.length > 0 && value.length <= 30 && !/[\s,]/.test(value);
}

/** DraftInput as stored: validated, with `angle` and `slides` defaulted so readers need not. */
export function parseDraftInput(raw: unknown): DraftInput {
    if (!isPlainObject(raw)) throw new StudioError(400, 'Send the draft settings as a JSON object.');
    const problems: string[] = [];

    let lessonIds: string[] = [];
    let lessonIdsBroken = false;
    if (raw.lessonIds !== undefined && raw.lessonIds !== null) {
        if (!Array.isArray(raw.lessonIds) || raw.lessonIds.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))) {
            problems.push('lessonIds must be a list of lesson ids');
            lessonIdsBroken = true;
        } else {
            lessonIds = unique(raw.lessonIds.map((id: string) => id.toLowerCase()));
            if (lessonIds.length > 3) problems.push('Ground a post in at most 3 lessons');
        }
    }

    let idea: string | undefined;
    if (raw.idea !== undefined && raw.idea !== null) {
        if (typeof raw.idea !== 'string') problems.push('idea must be text');
        else if (raw.idea.trim().length > 1000) problems.push('Keep the idea under 1000 characters');
        else idea = raw.idea.trim() || undefined;
    }
    // Not said on top of a broken lessonIds: the operator did pick lessons, one id was just bad.
    if (lessonIds.length === 0 && !idea && !lessonIdsBroken) problems.push('Pick a lesson, or write what the post should be about');

    const angle = raw.angle ?? 'auto';
    if (!(DRAFT_ANGLES as readonly unknown[]).includes(angle)) problems.push(`angle must be one of ${DRAFT_ANGLES.join(', ')}`);

    const slides = raw.slides ?? 8;
    if (!Number.isInteger(slides) || (slides as number) < 6 || (slides as number) > 10) {
        problems.push('slides must be a whole number from 6 to 10');
    }

    let keyword: string | undefined;
    if (raw.keyword !== undefined && raw.keyword !== null && raw.keyword !== '') {
        if (typeof raw.keyword !== 'string' || !isOneWord(raw.keyword.trim())) problems.push('keyword must be one word');
        else keyword = raw.keyword.trim();
    }

    let accent: string | undefined;
    if (raw.accent !== undefined && raw.accent !== null && raw.accent !== '') {
        if (typeof raw.accent !== 'string' || !HEX_COLOUR.test(raw.accent)) problems.push('accent must be a colour like #FFD60A');
        else accent = raw.accent.toUpperCase();
    }

    if (problems.length) throw problemsError(problems, 'the draft settings');
    return {
        lessonIds,
        ...(idea ? { idea } : {}),
        angle: angle as DraftAngle,
        slides: slides as number,
        ...(keyword ? { keyword } : {}),
        ...(accent ? { accent } : {}),
    };
}

/** Enough shape that `validateCarousel` can read it. Its own rules run on top of this. */
export function carouselShapeProblems(c: unknown): string[] {
    if (!isPlainObject(c)) return ['This draft has no carousel yet'];
    const problems: string[] = [];
    if (typeof c.id !== 'string' || !c.id) problems.push('carousel.id is missing');
    if (typeof c.accent !== 'string') problems.push('carousel.accent is missing');
    if (typeof c.keyword !== 'string') problems.push('carousel.keyword is missing');
    if (!Array.isArray(c.slides) || c.slides.some((s) => !isPlainObject(s) || typeof s.kind !== 'string')) {
        problems.push('carousel.slides must be a list of slides');
    }
    if (!isPlainObject(c.captions)) problems.push('carousel.captions is missing');
    return problems;
}

const MAX_SHOTS = 40;

export function parseShots(raw: unknown, problems: string[]): Record<string, ShotSpec> {
    if (raw === undefined || raw === null) return {};
    if (!isPlainObject(raw)) {
        problems.push('shots must be an object of name → shot');
        return {};
    }
    const entries = Object.entries(raw);
    if (entries.length > MAX_SHOTS) problems.push(`A draft holds at most ${MAX_SHOTS} shots`);
    const out: Record<string, ShotSpec> = {};
    for (const [name, spec] of entries.slice(0, MAX_SHOTS)) {
        const at = `shots["${name}"]`;
        if (!name.trim() || name.length > 100) {
            problems.push(`${at}: a shot name is 1 to 100 characters`);
            continue;
        }
        if (!isPlainObject(spec)) {
            problems.push(`${at} must be a shot`);
            continue;
        }
        const before = problems.length;
        const zoom = spec.zoom ?? 1;
        const focusX = spec.focusX ?? 0.5;
        const focusY = spec.focusY ?? 0.5;
        if (typeof spec.lessonId !== 'string' || !UUID_PATTERN.test(spec.lessonId)) problems.push(`${at}.lessonId must be a lesson id`);
        if (!(isFiniteNumber(spec.t) && spec.t >= 0)) problems.push(`${at}.t must be seconds into the video`);
        if (!(isFiniteNumber(zoom) && zoom >= 1 && zoom <= 4)) problems.push(`${at}.zoom must be from 1 (the whole frame) to 4`);
        if (!(isFiniteNumber(focusX) && focusX >= 0 && focusX <= 1)) problems.push(`${at}.focusX must be from 0 to 1`);
        if (!(isFiniteNumber(focusY) && focusY >= 0 && focusY <= 1)) problems.push(`${at}.focusY must be from 0 to 1`);
        if (spec.desc !== undefined && typeof spec.desc !== 'string') problems.push(`${at}.desc must be text`);
        if (problems.length > before) continue;
        out[name] = {
            lessonId: (spec.lessonId as string).toLowerCase(),
            t: spec.t as number,
            zoom: zoom as number,
            focusX: focusX as number,
            focusY: focusY as number,
            ...(typeof spec.desc === 'string' && spec.desc.trim() ? { desc: spec.desc.trim().slice(0, 500) } : {}),
        };
    }
    return out;
}

/**
 * The campaign, and the one rule that ties it to the carousel: it must answer the word the CTA
 * asks for. A mismatch is the silent kind of failure — every comment arrives and none is answered.
 */
export function parseCampaign(raw: unknown, carousel: unknown, problems: string[]): DraftCampaign | null {
    if (raw === undefined || raw === null) return null;
    if (!isPlainObject(raw)) {
        problems.push('campaign must be { keyword, variants, dm, create }');
        return null;
    }
    const keyword = typeof raw.keyword === 'string' ? raw.keyword.trim() : '';
    if (!isOneWord(keyword)) problems.push('campaign.keyword must be one word');
    const variants = raw.variants ?? [];
    const variantsOk = Array.isArray(variants)
        && variants.every((v) => typeof v === 'string' && isOneWord(v.trim()));
    if (!variantsOk) problems.push('campaign.variants must be a list of single words');
    const dm = typeof raw.dm === 'string' ? raw.dm : '';
    if (!dm.trim()) problems.push('campaign.dm is the message the keyword sends: it cannot be empty');
    else if (dm.length > 4000) problems.push('campaign.dm is longer than 4000 characters');
    if (raw.create !== undefined && typeof raw.create !== 'boolean') problems.push('campaign.create must be true or false');
    const carouselKeyword = isPlainObject(carousel) && typeof carousel.keyword === 'string' ? carousel.keyword.trim() : null;
    if (keyword && carouselKeyword && normalizeArabic(keyword) !== normalizeArabic(carouselKeyword)) {
        problems.push(`The campaign answers "${keyword}" but the carousel asks for "${carouselKeyword}": they must be the same word`);
    }
    return {
        keyword,
        variants: variantsOk ? unique((variants as string[]).map((v) => v.trim())) : [],
        dm,
        create: raw.create !== false,
    };
}

// ─── Sources, shots and the render payload ──────────────────────────────────────────────

type Source = { lesson: LessonRow; moments: Moment[] };

/**
 * The lessons a draft is grounded in, with their moments, in the order asked for. A lesson with
 * no notes cannot ground anything, so asking to generate from one is refused rather than
 * letting the model fill the gap.
 */
async function loadSources(creatorId: string, lessonIds: readonly string[], requireNotes: boolean): Promise<Source[]> {
    if (lessonIds.length === 0) return [];
    const lessons = await queryRows<LessonRow>(
        `SELECT ${LESSON_COLUMNS} FROM course_lessons WHERE creator_id = $1 AND id = ANY($2::uuid[])`,
        [creatorId, [...lessonIds]]
    );
    const byId = new Map(lessons.map((lesson) => [String(lesson.id).toLowerCase(), lesson]));
    const problems: string[] = [];
    for (const id of lessonIds) {
        const lesson = byId.get(id);
        if (!lesson) problems.push(`Lesson ${id} does not exist`);
        else if (requireNotes && !lesson.notes) {
            problems.push(`Lesson ${lesson.lesson_no} (${lesson.title}) is not indexed yet: index it first so the post has something true to say`);
        }
    }
    if (problems.length) throw problemsError(problems, 'the chosen lessons');
    const moments = await queryRows<Moment>(
        `SELECT ${MOMENT_COLUMNS} FROM lesson_moments WHERE lesson_id = ANY($1::uuid[]) ORDER BY t`,
        [[...lessonIds]]
    );
    return lessonIds.map((id) => ({
        lesson: byId.get(id)!,
        moments: moments.filter((m) => String(m.lesson_id).toLowerCase() === id),
    }));
}

function slideShotName(slide: unknown): string | null {
    if (!isPlainObject(slide) || !isPlainObject(slide.shot)) return null;
    return typeof slide.shot.name === 'string' ? slide.shot.name : null;
}

const MOMENT_SHOT = /^m-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Add a ShotSpec for every slide that names a moment (`m-<momentId>`) the shots map lacks, the
 * way generation makes them: the moment's time, zoom 1.3, centred. A rewrite or an edit that
 * picks a new moment then just works, instead of failing on "unknown shot".
 */
export async function fillMomentShots(
    creatorId: string, carousel: Carousel, shots: Record<string, ShotSpec>
): Promise<Record<string, ShotSpec>> {
    const wanted = unique(carousel.slides.map(slideShotName).filter((n): n is string => Boolean(n) && !shots[n!]));
    const ids = wanted.map((name) => MOMENT_SHOT.exec(name)?.[1]?.toLowerCase()).filter((id): id is string => Boolean(id));
    if (ids.length === 0) return shots;
    const rows = await queryRows<Pick<Moment, 'id' | 'lesson_id' | 't' | 'description'>>(
        `SELECT m.id, m.lesson_id, m.t::float8 AS t, m.description
           FROM lesson_moments m
           JOIN course_lessons l ON l.id = m.lesson_id
          WHERE m.id = ANY($1::uuid[]) AND l.creator_id = $2`,
        [ids, creatorId]
    );
    const out = { ...shots };
    for (const m of rows) {
        out[`m-${String(m.id).toLowerCase()}`] = {
            lessonId: String(m.lesson_id).toLowerCase(), t: m.t, zoom: 1.3, focusX: 0.5, focusY: 0.5, desc: m.description,
        };
    }
    return out;
}

/**
 * What the worker needs to render: the carousel, each shot the slides use with its video path,
 * and the tenant's brand, CTA words and product facts as they are now.
 */
async function renderPayload(
    creatorId: string, draftId: string, carousel: Carousel, shots: Record<string, ShotSpec>, settings: StudioSettings
): Promise<RenderCarouselPayload> {
    const used = unique(carousel.slides.map(slideShotName).filter((n): n is string => Boolean(n)));
    const problems = used.filter((name) => !shots[name]).map((name) => `A slide uses the shot "${name}", which this draft does not have`);
    const lessonIds = unique(used.flatMap((name) => (shots[name] ? [shots[name]!.lessonId] : [])));
    const paths = lessonIds.length
        ? await queryRows<{ id: string; video_path: string }>(
            'SELECT id, video_path FROM course_lessons WHERE creator_id = $1 AND id = ANY($2::uuid[])',
            [creatorId, lessonIds]
        )
        : [];
    const pathOf = new Map(paths.map((p) => [String(p.id).toLowerCase(), p.video_path]));
    const payloadShots: RenderCarouselPayload['shots'] = {};
    for (const name of used) {
        const shot = shots[name];
        if (!shot) continue;
        const videoPath = pathOf.get(shot.lessonId);
        if (!videoPath) problems.push(`The shot "${name}" is from a lesson that does not exist`);
        else payloadShots[name] = { ...shot, video_path: videoPath };
    }
    if (problems.length) throw problemsError(problems, 'the shots');
    return {
        draftId, carousel, shots: payloadShots,
        brand: settings.brand, cta: settings.cta.slide, facts: settings.product.facts,
    };
}

// ─── Generation context ─────────────────────────────────────────────────────────────────

function firstLine(text: string | null): string | null {
    return text?.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
}

/**
 * What the writer should avoid repeating and must not collide with (STUDIO.md §7, §10):
 *   - recentTopics: the last 20 drafts' titles, and the first lines of the last 20 carousel captions
 *   - recentAccents: the accents of the last 2 scheduled drafts
 *   - activeKeywords: every comma-separated trigger of every active campaign
 *   - palette: the tenant's brand palette
 */
export async function buildGenContext(creatorId: string, settings?: StudioSettings): Promise<GenContext> {
    const [studio, drafts, captions, accents, campaigns] = await Promise.all([
        settings ?? getStudioSettings(creatorId),
        queryRows<{ title: string | null; idea: string | null }>(
            `SELECT carousel->'slides'->0->>'title' AS title, input->>'idea' AS idea
               FROM carousel_drafts WHERE creator_id = $1
              ORDER BY created_at DESC LIMIT 20`,
            [creatorId]
        ),
        queryRows<{ caption: string | null }>(
            `SELECT caption FROM scheduled_posts
              WHERE creator_id = $1 AND post_type = 'carousel' AND platform <> 'tiktok' AND caption IS NOT NULL
              ORDER BY scheduled_time DESC LIMIT 20`,
            [creatorId]
        ),
        queryRows<{ accent: string | null }>(
            `SELECT carousel->>'accent' AS accent FROM carousel_drafts
              WHERE creator_id = $1 AND status = 'scheduled' AND carousel->>'accent' IS NOT NULL
              ORDER BY schedule->>'scheduled_time' DESC NULLS LAST, updated_at DESC
              LIMIT 2`,
            [creatorId]
        ),
        queryRows<{ trigger_keyword: string | null }>(
            'SELECT trigger_keyword FROM campaigns WHERE creator_id = $1 AND is_active = TRUE', [creatorId]
        ),
    ]);
    const topics = [
        ...drafts.map((d) => d.title?.trim() || d.idea?.trim() || null),
        ...captions.map((c) => firstLine(c.caption)),
    ].filter((t): t is string => Boolean(t));
    return {
        recentTopics: unique(topics),
        recentAccents: unique(accents.map((a) => a.accent).filter((a): a is string => Boolean(a))),
        activeKeywords: unique(campaigns.flatMap((c) => (c.trigger_keyword ?? '').split(','))
            .map((k) => k.trim()).filter(Boolean)),
        palette: [...studio.brand.palette],
        settings: studio,
    };
}

/**
 * A reused keyword, swapped for its campaign's main one. A campaign triggers on several words —
 * «منديل, رسمة, stitch» — and the writer may pick any of them, but the first is the one the
 * creator chose to ask for: in their audience's language, and the one the DM was written around.
 * The caption's ask line is rewritten to match, so the rules still find it.
 */
export async function preferPrimaryKeyword<T extends { carousel: Carousel; campaign: { keyword: string; create: boolean } & Record<string, unknown> }>(
    creatorId: string, generated: T, settings: StudioSettings,
): Promise<T> {
    const picked = normalizeArabic(generated.carousel.keyword.trim().toLowerCase());
    const campaigns = await queryRows<{ trigger_keyword: string | null }>(
        'SELECT trigger_keyword FROM campaigns WHERE creator_id = $1 AND is_active = TRUE ORDER BY created_at', [creatorId]
    );
    for (const c of campaigns) {
        const words = (c.trigger_keyword ?? '').split(',').map((w) => w.trim()).filter(Boolean);
        if (!words.some((w) => normalizeArabic(w.toLowerCase()) === picked)) continue;
        const primary = words[0]!;
        if (primary === generated.carousel.keyword) return generated;
        const ask = (k: string) => settings.cta.instagramAsk.replace('{keyword}', k);
        const caption = generated.carousel.captions.instagram.split(ask(generated.carousel.keyword)).join(ask(primary));
        return {
            ...generated,
            carousel: { ...generated.carousel, keyword: primary, captions: { ...generated.carousel.captions, instagram: caption } },
            campaign: { ...generated.campaign, keyword: primary },
        };
    }
    return generated;
}

// ─── Writes ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /drafts: generate, save, queue the render. Returns the draft `rendering`, or `failed`
 * with the reason — a generation failure is an outcome to show, not an HTTP error.
 */
export async function createDraft(creatorId: string, raw: unknown): Promise<Draft> {
    const input = parseDraftInput(raw);
    const [sources, settings] = await Promise.all([
        loadSources(creatorId, input.lessonIds, true),
        getStudioSettings(creatorId),
    ]);
    const { rows } = await pool.query<CarouselDraftRow>(
        `INSERT INTO carousel_drafts (creator_id, status, input) VALUES ($1, 'generating', $2::jsonb) RETURNING *`,
        [creatorId, JSON.stringify(input)]
    );
    const draft = rows[0]!;

    const fail = async (error: string, fields?: { carousel: unknown; shots: unknown; campaign: unknown }): Promise<Draft> => {
        const { rows: failed } = await pool.query<CarouselDraftRow>(
            `UPDATE carousel_drafts
                SET status = 'failed', error = $3, updated_at = NOW(),
                    carousel = COALESCE($4::jsonb, carousel), shots = COALESCE($5::jsonb, shots),
                    campaign = COALESCE($6::jsonb, campaign)
              WHERE id = $1 AND creator_id = $2
          RETURNING *`,
            [
                draft.id, creatorId, error,
                // SQL NULL for "nothing to keep", so COALESCE leaves the column alone.
                fields?.carousel != null ? JSON.stringify(fields.carousel) : null,
                fields?.shots != null ? JSON.stringify(fields.shots) : null,
                fields?.campaign != null ? JSON.stringify(fields.campaign) : null,
            ]
        );
        if (!failed[0]) throw new StudioError(404, 'This draft was deleted while it was being written.');
        return presentDraft(failed[0]);
    };

    let generated: Awaited<ReturnType<Generation['generateDraft']>>;
    try {
        generated = await generation.generateDraft(input, sources, await buildGenContext(creatorId, settings));
    } catch (err) {
        log('warn', 'studio.generate_failed', { draft_id: draft.id, ...describeError(err) });
        return fail(`Writing the carousel failed: ${errorText(err)}`);
    }

    if (generated?.carousel && generated.campaign && generated.campaign.create === false) {
        generated = await preferPrimaryKeyword(creatorId, generated, settings);
    }

    // The module repairs its own output; this is the backstop for one that still breaks a rule.
    // The carousel is kept on the failed draft, so the operator can fix it by hand.
    const problems = carouselShapeProblems(generated?.carousel);
    const shots = parseShots(generated?.shots, problems);
    const campaign = parseCampaign(generated?.campaign, generated?.carousel, problems);
    if (problems.length === 0) problems.push(...rulesProblems(generated.carousel, shots, settings));
    if (problems.length) {
        log('warn', 'studio.generate_invalid', { draft_id: draft.id, problems: problems.length });
        return fail(`The generated carousel breaks ${problems.length} rule${problems.length === 1 ? '' : 's'}: ${problems.slice(0, 3).join('; ')}`,
            { carousel: generated?.carousel ?? null, shots, campaign });
    }

    let payload: RenderCarouselPayload;
    try {
        payload = await renderPayload(creatorId, draft.id, generated.carousel, shots, settings);
    } catch (err) {
        if (!(err instanceof StudioError)) throw err;
        return fail(err.message, { carousel: generated.carousel, shots, campaign });
    }

    return withTransaction(async (client) => {
        const { rows: saved } = await client.query<CarouselDraftRow>(
            `UPDATE carousel_drafts
                SET carousel = $3::jsonb, shots = $4::jsonb, campaign = $5::jsonb, error = NULL, updated_at = NOW()
              WHERE id = $1 AND creator_id = $2 AND status = 'generating'
          RETURNING id`,
            [draft.id, creatorId, JSON.stringify(generated.carousel), JSON.stringify(shots), campaign ? JSON.stringify(campaign) : null]
        );
        if (!saved[0]) throw new StudioError(404, 'This draft was deleted while it was being written.');
        const { draft: rendering } = await enqueueRender(client, creatorId, payload);
        return presentDraft(rendering!);
    });
}

/** PATCH: validate, save, re-render. Anything not sent is kept as it is. */
export async function patchDraft(creatorId: string, draftId: string, body: unknown): Promise<Draft> {
    if (!isPlainObject(body) || !('carousel' in body || 'shots' in body || 'campaign' in body)) {
        throw new StudioError(400, 'Send the carousel, shots or campaign to change.');
    }
    const draft = await loadDraft(pool, creatorId, draftId);
    assertEditable(draft);

    const carousel = 'carousel' in body ? body.carousel : draft.carousel;
    const problems = carouselShapeProblems(carousel);
    const parsedShots = parseShots('shots' in body ? body.shots : draft.shots, problems);
    const campaign = parseCampaign('campaign' in body ? body.campaign : draft.campaign, carousel, problems);
    if (problems.length) throw problemsError(problems, 'this draft');

    const [shots, settings] = await Promise.all([
        fillMomentShots(creatorId, carousel as Carousel, parsedShots),
        getStudioSettings(creatorId),
    ]);
    const rules = rulesProblems(carousel as Carousel, shots, settings);
    if (rules.length) throw problemsError(rules, 'this carousel');

    const payload = await renderPayload(creatorId, draft.id, carousel as Carousel, shots, settings);
    return withTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
            `UPDATE carousel_drafts
                SET carousel = $3::jsonb, shots = $4::jsonb, campaign = $5::jsonb, updated_at = NOW()
              WHERE id = $1 AND creator_id = $2 AND status <> 'scheduled'
          RETURNING id`,
            [draft.id, creatorId, JSON.stringify(carousel), JSON.stringify(shots), campaign ? JSON.stringify(campaign) : null]
        );
        if (!rows[0]) throw new StudioError(409, 'This draft was scheduled or deleted while you were editing it.');
        const { draft: rendering } = await enqueueRender(client, creatorId, payload);
        return presentDraft(rendering!);
    });
}

/**
 * POST /drafts/:id/rewrite: one slide, rewritten by the model within its budgets. Saved only if
 * the draft is still what was rewritten — the call takes long enough for an edit to land meanwhile.
 */
export async function rewriteDraftSlide(creatorId: string, draftId: string, body: unknown): Promise<Draft> {
    const b = isPlainObject(body) ? body : {};
    const draft = await loadDraft(pool, creatorId, draftId);
    assertEditable(draft);
    if (!draft.carousel) throw new StudioError(409, 'This draft has no carousel to rewrite yet.');
    const index = b.index;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= draft.carousel.slides.length) {
        throw new StudioError(400, `index must be a slide number from 0 to ${draft.carousel.slides.length - 1}.`);
    }
    if (b.instruction !== undefined && b.instruction !== null && typeof b.instruction !== 'string') {
        throw new StudioError(400, 'instruction must be text.');
    }
    const instruction = typeof b.instruction === 'string' && b.instruction.trim() ? b.instruction.trim().slice(0, 500) : undefined;

    const [sources, settings] = await Promise.all([
        loadSources(creatorId, draft.input?.lessonIds ?? [], false),
        getStudioSettings(creatorId),
    ]);
    let slide: Slide;
    try {
        slide = await generation.rewriteSlide(draft.carousel, index as number, instruction, sources, await buildGenContext(creatorId, settings));
    } catch (err) {
        log('warn', 'studio.rewrite_failed', { draft_id: draft.id, ...describeError(err) });
        throw new StudioError(502, `Rewriting the slide failed: ${errorText(err)}`);
    }
    if (!isPlainObject(slide) || typeof slide.kind !== 'string') throw new StudioError(502, 'The rewrite came back without a slide.');

    const carousel: Carousel = { ...draft.carousel, slides: draft.carousel.slides.map((s, i) => (i === index ? slide : s)) };
    const shots = await fillMomentShots(creatorId, carousel, draft.shots ?? {});
    const rules = rulesProblems(carousel, shots, settings);
    if (rules.length) throw problemsError(rules, 'the rewritten slide', 422);

    const payload = await renderPayload(creatorId, draft.id, carousel, shots, settings);
    return withTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
            `UPDATE carousel_drafts SET carousel = $3::jsonb, shots = $4::jsonb, updated_at = NOW()
              WHERE id = $1 AND creator_id = $2 AND status <> 'scheduled'
                AND carousel = $5::jsonb AND shots IS NOT DISTINCT FROM $6::jsonb
          RETURNING id`,
            [
                draft.id, creatorId, JSON.stringify(carousel), JSON.stringify(shots),
                JSON.stringify(draft.carousel), draft.shots ? JSON.stringify(draft.shots) : null,
            ]
        );
        if (!rows[0]) throw new StudioError(409, 'The draft changed while the slide was being rewritten. Reload it and try again.');
        const { draft: rendering } = await enqueueRender(client, creatorId, payload);
        return presentDraft(rendering!);
    });
}

/** POST /drafts/:id/render: render the draft as it is. */
export async function renderDraft(creatorId: string, draftId: string): Promise<StudioJobView> {
    const draft = await loadDraft(pool, creatorId, draftId);
    assertEditable(draft);
    const settings = await getStudioSettings(creatorId);
    const problems = carouselShapeProblems(draft.carousel);
    if (problems.length === 0) problems.push(...rulesProblems(draft.carousel!, draft.shots ?? {}, settings));
    if (problems.length) throw problemsError(problems, 'this draft');
    const payload = await renderPayload(creatorId, draft.id, draft.carousel!, draft.shots ?? {}, settings);
    return withTransaction(async (client) => (await enqueueRender(client, creatorId, payload)).job);
}

/** DELETE: the draft, its queued renders, and its render's uploads. Refused once scheduled. */
export async function deleteDraft(creatorId: string, draftId: string): Promise<void> {
    await withTransaction(async (client) => {
        const draft = await loadDraft(client, creatorId, draftId, true);
        if (draft.status === 'scheduled') {
            throw new StudioError(409, 'A scheduled draft cannot be deleted: it is the record of what was posted.');
        }
        await cancelRenders(client, creatorId, draft.id, 'The draft was deleted.');
        await client.query('DELETE FROM carousel_drafts WHERE id = $1 AND creator_id = $2', [draft.id, creatorId]);
        await deleteUnreferencedUploads(client, creatorId, [...(draft.render?.ig ?? []), ...(draft.render?.tt ?? [])]);
    });
}

/** Tick or untick "made public on TikTok". Ticking needs a TikTok post to have been made. */
export async function setTikTokPublic(creatorId: string, draftId: string, body: unknown): Promise<Draft> {
    if (!isPlainObject(body) || typeof body.done !== 'boolean') throw new StudioError(400, 'Send { "done": true } or { "done": false }.');
    const draft = await loadDraft(pool, creatorId, draftId);
    if (!draft.schedule) throw new StudioError(409, 'This draft is not scheduled yet.');
    if (body.done && !draft.schedule.tiktok_row_id) throw new StudioError(409, 'This draft has no TikTok post yet.');
    const { rows } = await pool.query<CarouselDraftRow>(
        `UPDATE carousel_drafts
            SET schedule = jsonb_set(schedule, '{tiktok_public_done}', to_jsonb($3::boolean)), updated_at = NOW()
          WHERE id = $1 AND creator_id = $2 AND schedule IS NOT NULL
      RETURNING *`,
        [draft.id, creatorId, body.done]
    );
    if (!rows[0]) throw new StudioError(404, 'No such draft.');
    return presentDraft(rows[0]);
}

export type PlanProposal = Awaited<ReturnType<Generation['planWeek']>>[number] & { slot: string | null };

/**
 * POST /plan: proposals for the next `count` free slots. Nothing is saved — the dashboard
 * POSTs /drafts for each proposal it keeps.
 */
export async function planDrafts(creatorId: string, body: unknown): Promise<PlanProposal[]> {
    const b = isPlainObject(body) ? body : {};
    const count = b.count;
    if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 14) {
        throw new StudioError(400, 'count must be a whole number from 1 to 14.');
    }
    let lessonIds: string[] | null = null;
    if (b.lessonIds !== undefined && b.lessonIds !== null) {
        if (!Array.isArray(b.lessonIds) || b.lessonIds.length > 50
            || b.lessonIds.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))) {
            throw new StudioError(400, 'lessonIds must be a list of up to 50 lesson ids.');
        }
        lessonIds = unique(b.lessonIds.map((id: string) => id.toLowerCase()));
    }
    const settings = await getStudioSettings(creatorId);
    const lessons = lessonIds
        ? (await loadSources(creatorId, lessonIds, true)).map((s) => s.lesson)
        : await queryRows<LessonRow>(
            `SELECT ${LESSON_COLUMNS} FROM course_lessons WHERE creator_id = $1 AND notes IS NOT NULL`, [creatorId]
        );

    let proposals: Awaited<ReturnType<Generation['planWeek']>>;
    try {
        proposals = await generation.planWeek(count as number, lessons, await buildGenContext(creatorId, settings));
    } catch (err) {
        log('warn', 'studio.plan_failed', describeError(err));
        throw new StudioError(502, `Planning failed: ${errorText(err)}`);
    }
    // Slots are assigned here, not by the model: it cannot see the calendar.
    const slots = await nextFreeSlots(creatorId, settings.schedule, count as number);
    return (Array.isArray(proposals) ? proposals : []).slice(0, count as number)
        .map((proposal, i) => ({ ...proposal, slot: slots[i] ?? null }));
}
