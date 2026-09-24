/**
 * Drafts: generation around the model, validation, the stale-generation rule, and what an edit
 * or a rewrite saves and re-renders. The generation module is replaced through `setGeneration`
 * (Gemini is never called), and the pool answers by SQL.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import type { CarouselDraftRow } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import type { Carousel } from './carouselTypes.js';
import { StudioError } from './common.js';
import {
    buildGenContext, createDraft, parseDraftInput, patchDraft, preferPrimaryKeyword, presentDraft, rewriteDraftSlide, setGeneration,
    STALE_GENERATION_ERROR, STALE_GENERATION_MS,
} from './drafts.js';
import { defaultStudioSettings } from './settings.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const LESSON = '66666666-6666-4666-8666-666666666666';
const DRAFT = '77777777-7777-4777-8777-777777777777';
const MOMENT = '88888888-8888-4888-8888-888888888888';
const NEW_MOMENT = '89898989-8989-4898-8989-898989898989';

const CAROUSEL: Carousel = {
    id: 'NotebookTips',
    accent: '#22C7F0',
    keyword: 'دفتر',
    slides: [
        { kind: 'cover', title: 'عنوان', shot: { name: `m-${MOMENT}` } },
        { kind: 'point', title: 'نقطة' },
        { kind: 'cta' },
    ],
    captions: { instagram: 'اكتب "دفتر"', tiktokTitle: 'عنوان', tiktok: 'رابطه في البايو' },
};
const SHOTS = { [`m-${MOMENT}`]: { lessonId: LESSON, t: 12.5, zoom: 1.3, focusX: 0.5, focusY: 0.5 } };
const CAMPAIGN = { keyword: 'دفتر', variants: ['الدفتر'], dm: 'هلا {username}', create: true };

function draftRow(fields: Partial<CarouselDraftRow> = {}): CarouselDraftRow {
    const now = new Date();
    return {
        id: DRAFT, creator_id: TENANT, status: 'ready', input: { lessonIds: [LESSON], angle: 'auto', slides: 8 },
        carousel: CAROUSEL, shots: SHOTS, campaign: CAMPAIGN, render: null, schedule: null, error: null,
        created_at: now, updated_at: now, ...fields,
    };
}

type Rows = { rows: any[]; rowCount?: number };
let statements: { sql: string; params: any[] }[] = [];
let routes: [RegExp, (params: any[]) => Rows][] = [];
const original = { query: pool.query, connect: pool.connect };
let restoreSink: (() => void) | undefined;

before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    statements = [];
    routes = [];
    const run = async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        statements.push({ sql: flat, params });
        const route = routes.find(([pattern]) => pattern.test(flat));
        const r = route ? route[1](params) : { rows: [] };
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };
    (pool as unknown as { query: unknown }).query = run;
    (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release() {} });
});
afterEach(() => {
    (pool as unknown as { query: unknown }).query = original.query;
    (pool as unknown as { connect: unknown }).connect = original.connect;
    setGeneration(null);
});

const ran = (pattern: RegExp) => statements.filter((s) => pattern.test(s.sql));
const isStudioError = (status: number) => (err: unknown) => err instanceof StudioError && err.status === status;

/** The library, the draft table and the job queue, as far as generation and rendering read them. */
function library(draft: CarouselDraftRow = draftRow()) {
    routes.push(
        [/duration_s::float8 AS duration_s, status, notes/, () => ({
            rows: [{ id: LESSON, lesson_no: '1.2', title: 'Lesson', video_path: '/v/1.2.mp4', notes: { summary: 's' } }],
        })],
        [/FROM lesson_moments WHERE lesson_id = ANY/, () => ({
            rows: [{ id: MOMENT, lesson_id: LESSON, t: 12.5, description: 'Screen', kind: 'ui', clean: true, thumb_url: null }],
        })],
        [/^SELECT id, video_path FROM course_lessons/, () => ({ rows: [{ id: LESSON, video_path: '/v/1.2.mp4' }] })],
        [/^INSERT INTO carousel_drafts/, (params) => ({ rows: [draftRow({ status: 'generating', input: JSON.parse(params[1]), carousel: null, shots: null, campaign: null })] })],
        [/^SELECT \* FROM carousel_drafts WHERE id = \$1/, () => ({ rows: [draft] })],
        [/^UPDATE carousel_drafts SET carousel = \$3::jsonb/, () => ({ rows: [{ id: DRAFT }] })],
        [/^INSERT INTO studio_jobs/, (params) => ({ rows: [{ id: 'job-1', kind: params[1], status: 'pending', payload: JSON.parse(params[2]) }] })],
        [/^UPDATE carousel_drafts SET status = 'rendering'/, () => ({ rows: [draftRow({ status: 'rendering' })] })],
        [/^UPDATE carousel_drafts SET status = 'failed'/, (params) => ({ rows: [draftRow({ status: 'failed', error: params[2] })] })],
    );
}

const renderJob = () => {
    const [insert] = ran(/^INSERT INTO studio_jobs/);
    assert.ok(insert, 'a render job was queued');
    assert.equal(insert!.params[1], 'render_carousel');
    return JSON.parse(insert!.params[2]);
};

// ─── Presentation ───────────────────────────────────────────────────────────────────────

describe('presentDraft', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');

    it('reads a draft stuck in generating for more than ten minutes as failed', () => {
        const stuck = draftRow({ status: 'generating', updated_at: new Date(now - STALE_GENERATION_MS - 1) });
        const shown = presentDraft(stuck, now);
        assert.equal(shown.status, 'failed');
        assert.equal(shown.error, STALE_GENERATION_ERROR);
    });

    it('leaves one still inside the window, and every other status, as it is', () => {
        assert.equal(presentDraft(draftRow({ status: 'generating', updated_at: new Date(now - 60_000) }), now).status, 'generating');
        assert.equal(presentDraft(draftRow({ status: 'rendering', updated_at: new Date(0) }), now).status, 'rendering');
    });

    it('never serves the tenant id', () => {
        assert.ok(!('creator_id' in presentDraft(draftRow(), now)));
    });
});

// ─── Input ──────────────────────────────────────────────────────────────────────────────

describe('parseDraftInput', () => {
    it('fills in the defaults, and normalises ids and the accent', () => {
        assert.deepEqual(parseDraftInput({ lessonIds: [LESSON.toUpperCase()], accent: '#22c7f0' }), {
            lessonIds: [LESSON], angle: 'auto', slides: 8, accent: '#22C7F0',
        });
    });

    it('needs a lesson or an idea', () => {
        assert.throws(() => parseDraftInput({}), isStudioError(400));
        assert.deepEqual(parseDraftInput({ idea: '  Prompt tips ' }), { lessonIds: [], idea: 'Prompt tips', angle: 'auto', slides: 8 });
    });

    it('lists every problem at once', () => {
        assert.throws(
            () => parseDraftInput({ lessonIds: [LESSON, 'nope'], slides: 12, angle: 'story', keyword: 'two words', accent: 'blue' }),
            (err: unknown) => err instanceof StudioError && err.status === 400 && err.problems?.length === 5
        );
        assert.throws(() => parseDraftInput({ lessonIds: [LESSON, MOMENT, NEW_MOMENT, DRAFT] }), (err: unknown) =>
            err instanceof StudioError && (err.problems ?? []).some((p) => /at most 3 lessons/.test(p)));
    });
});

// ─── Generation context ─────────────────────────────────────────────────────────────────

describe('buildGenContext', () => {
    it('collects recent topics, recent accents, active keywords, and the tenant’s palette and settings', async () => {
        routes.push(
            [/carousel->'slides'->0->>'title'/, () => ({ rows: [{ title: 'Cover A', idea: null }, { title: null, idea: 'Idea B' }] })],
            [/FROM scheduled_posts WHERE creator_id = \$1 AND post_type = 'carousel'/, () => ({ rows: [{ caption: '\n  First line \nmore' }, { caption: 'Cover A\nagain' }] })],
            [/carousel->>'accent' AS accent/, () => ({ rows: [{ accent: '#FFD60A' }, { accent: '#22C7F0' }] })],
            [/FROM campaigns WHERE creator_id = \$1 AND is_active/, () => ({ rows: [{ trigger_keyword: 'متجر, store' }, { trigger_keyword: ' دفتر ,متجر' }] })],
            [/FROM studio_settings/, () => ({ rows: [{ brand: { palette: ['#111111', '#222222'] } }] })],
        );
        const ctx = await buildGenContext(TENANT);
        assert.deepEqual(ctx.recentTopics, ['Cover A', 'Idea B', 'First line']);
        assert.deepEqual(ctx.recentAccents, ['#FFD60A', '#22C7F0']);
        assert.deepEqual(ctx.activeKeywords, ['متجر', 'store', 'دفتر']);
        assert.deepEqual(ctx.palette, ['#111111', '#222222'], 'the tenant’s brand palette, not a constant');
        assert.deepEqual(ctx.settings.brand.palette, ['#111111', '#222222']);
        assert.equal(ctx.settings.voice.language, 'en', 'the rest over the defaults');

        assert.match(ran(/carousel->'slides'->0->>'title'/)[0]!.sql, /LIMIT 20/);
        assert.match(ran(/FROM scheduled_posts/)[0]!.sql, /LIMIT 20/);
        const [accents] = ran(/carousel->>'accent' AS accent/);
        assert.match(accents!.sql, /status = 'scheduled'/);
        assert.match(accents!.sql, /LIMIT 2/);
    });
});

// ─── Create ─────────────────────────────────────────────────────────────────────────────

describe('createDraft', () => {
    it('generates, saves, and queues a render carrying the video paths and the tenant’s brand', async () => {
        library();
        let seen: any;
        // The rules have their own suite; this one is about what happens around them.
        setGeneration({
            generateDraft: async (input, sources, ctx) => {
                seen = { input, sources, ctx };
                return { carousel: CAROUSEL, shots: SHOTS, campaign: CAMPAIGN };
            },
            validateCarousel: () => [],
        });
        const draft = await createDraft(TENANT, { lessonIds: [LESSON], angle: 'tips' });
        assert.equal(draft.status, 'rendering');

        assert.equal(seen.input.angle, 'tips');
        assert.equal(seen.sources[0].lesson.id, LESSON);
        assert.equal(seen.sources[0].moments[0].id, MOMENT);
        assert.ok(seen.ctx.settings, 'the context carries the settings');

        const payload = renderJob();
        assert.equal(payload.draftId, DRAFT);
        assert.deepEqual(payload.carousel, CAROUSEL);
        assert.deepEqual(payload.shots, { [`m-${MOMENT}`]: { ...SHOTS[`m-${MOMENT}`], video_path: '/v/1.2.mp4' } });
        const defaults = defaultStudioSettings();
        assert.deepEqual(payload.brand, defaults.brand);
        assert.deepEqual(payload.cta, defaults.cta.slide);
        assert.deepEqual(payload.facts, defaults.product.facts);
    });

    it('refuses a lesson that is not indexed, before anything is generated or saved', async () => {
        routes.push([/duration_s::float8 AS duration_s, status, notes/, () => ({
            rows: [{ id: LESSON, lesson_no: '1.2', title: 'Lesson', notes: null }],
        })]);
        let called = false;
        setGeneration({ generateDraft: async () => { called = true; throw new Error('unreachable'); } });
        await assert.rejects(createDraft(TENANT, { lessonIds: [LESSON] }), isStudioError(400));
        assert.equal(called, false);
        assert.equal(ran(/^INSERT/).length, 0);
    });

    it('answers a failed generation with the draft marked failed, not an HTTP error', async () => {
        library();
        setGeneration({ generateDraft: async () => { throw new Error('Gemini timed out after 120s'); } });
        const draft = await createDraft(TENANT, { lessonIds: [LESSON] });
        assert.equal(draft.status, 'failed');
        assert.match(draft.error!, /Gemini timed out/);
        assert.equal(ran(/^INSERT INTO studio_jobs/).length, 0);
    });

    it('keeps a generated carousel that still breaks a rule, failed, so it can be fixed by hand', async () => {
        library();
        setGeneration({
            generateDraft: async () => ({ carousel: CAROUSEL, shots: SHOTS, campaign: CAMPAIGN }),
            validateCarousel: () => ['slide 2: title is 45 characters; the limit is 40'],
        });
        const draft = await createDraft(TENANT, { lessonIds: [LESSON] });
        assert.equal(draft.status, 'failed');
        assert.match(draft.error!, /breaks 1 rule: slide 2/);
        const [failed] = ran(/^UPDATE carousel_drafts SET status = 'failed'/);
        assert.deepEqual(JSON.parse(failed!.params[3]), CAROUSEL, 'the carousel is kept on the draft');
        assert.equal(ran(/^INSERT INTO studio_jobs/).length, 0);
    });
});

// ─── Edit ───────────────────────────────────────────────────────────────────────────────

describe('patchDraft', () => {
    it('answers 400 with every problem validateCarousel finds, and saves nothing', async () => {
        library();
        setGeneration({ validateCarousel: () => ['slide 1: highlight is not in the title', 'the last slide must be cta'] });
        await assert.rejects(
            patchDraft(TENANT, DRAFT, { carousel: CAROUSEL }),
            (err: unknown) => err instanceof StudioError && err.status === 400
                && err.problems?.length === 2 && /2 problems/.test(err.message)
        );
        assert.equal(ran(/^UPDATE carousel_drafts/).length, 0);
        assert.equal(ran(/^INSERT INTO studio_jobs/).length, 0);
    });

    it('hands the rules the shot names and the tenant’s settings, which hold the CTA lines they check', async () => {
        library();
        routes.unshift([/FROM studio_settings/, () => ({ rows: [{ cta: { tiktokLine: 'Link in bio, always' } }] })]);
        let seen: unknown[] = [];
        setGeneration({ validateCarousel: (...args) => { seen = args; return []; } });
        await patchDraft(TENANT, DRAFT, { carousel: CAROUSEL });
        assert.deepEqual([...(seen[1] as Set<string>)], [`m-${MOMENT}`]);
        assert.equal((seen[2] as { cta: { tiktokLine: string } }).cta.tiktokLine, 'Link in bio, always');
    });

    it('refuses an edit once the draft is scheduled', async () => {
        library(draftRow({ status: 'scheduled' }));
        await assert.rejects(patchDraft(TENANT, DRAFT, { carousel: CAROUSEL }), isStudioError(409));
    });

    it('refuses a campaign that answers a different word than the carousel asks for', async () => {
        library();
        await assert.rejects(
            patchDraft(TENANT, DRAFT, { campaign: { ...CAMPAIGN, keyword: 'متجر' } }),
            (err: unknown) => err instanceof StudioError && (err.problems ?? []).some((p) => /must be the same word/.test(p))
        );
    });

    it('refuses something that is not a carousel before the rules ever see it', async () => {
        library();
        let called = false;
        setGeneration({ validateCarousel: () => { called = true; return []; } });
        await assert.rejects(patchDraft(TENANT, DRAFT, { carousel: 'text' }), isStudioError(400));
        assert.equal(called, false);
    });

    it('saves what was sent, keeps what was not, and re-renders', async () => {
        library();
        setGeneration({ validateCarousel: () => [] });
        const edited = { ...CAROUSEL, captions: { ...CAROUSEL.captions, instagram: 'اكتب "دفتر" الحين' } };
        const draft = await patchDraft(TENANT, DRAFT, { carousel: edited });
        assert.equal(draft.status, 'rendering');
        const [save] = ran(/^UPDATE carousel_drafts SET carousel = \$3::jsonb/);
        assert.deepEqual(JSON.parse(save!.params[2]), edited);
        assert.deepEqual(JSON.parse(save!.params[3]), SHOTS, 'shots were not sent, so they are kept');
        assert.deepEqual(JSON.parse(save!.params[4]), CAMPAIGN);
        assert.equal(renderJob().carousel.captions.instagram, 'اكتب "دفتر" الحين');
    });
});

describe('rewriteDraftSlide', () => {
    it('adds the shot for a newly picked moment, and saves only if the draft is unchanged since', async () => {
        library();
        routes.push([/FROM lesson_moments m JOIN course_lessons l/, () => ({
            rows: [{ id: NEW_MOMENT, lesson_id: LESSON, t: 40, description: 'Result screen' }],
        })]);
        setGeneration({
            rewriteSlide: async () => ({ kind: 'shot', title: 'النتيجة', shot: { name: `m-${NEW_MOMENT}` } }),
            validateCarousel: () => [],
        });

        const draft = await rewriteDraftSlide(TENANT, DRAFT, { index: 1, instruction: 'show the result' });
        assert.equal(draft.status, 'rendering');

        const [save] = ran(/^UPDATE carousel_drafts SET carousel = \$3::jsonb, shots = \$4::jsonb, updated_at/);
        assert.match(save!.sql, /AND carousel = \$5::jsonb AND shots IS NOT DISTINCT FROM \$6::jsonb/);
        assert.deepEqual(JSON.parse(save!.params[4]), CAROUSEL, 'compared against the carousel that was rewritten');
        const shots = JSON.parse(save!.params[3]);
        assert.deepEqual(shots[`m-${NEW_MOMENT}`], {
            lessonId: LESSON, t: 40, zoom: 1.3, focusX: 0.5, focusY: 0.5, desc: 'Result screen',
        });
        assert.equal(JSON.parse(save!.params[2]).slides[1].kind, 'shot');
    });

    it('409s when an edit landed while the model was rewriting', async () => {
        library();
        routes.unshift([/^UPDATE carousel_drafts SET carousel = \$3::jsonb, shots = \$4::jsonb, updated_at/, () => ({ rows: [] })]);
        setGeneration({ rewriteSlide: async () => ({ kind: 'point', title: 'جديد' }), validateCarousel: () => [] });
        await assert.rejects(rewriteDraftSlide(TENANT, DRAFT, { index: 1 }), isStudioError(409));
        assert.equal(ran(/^INSERT INTO studio_jobs/).length, 0);
    });

    it('refuses an index outside the carousel', async () => {
        library();
        await assert.rejects(rewriteDraftSlide(TENANT, DRAFT, { index: 3 }), isStudioError(400));
    });
});

describe('preferPrimaryKeyword', () => {
    const settings = defaultStudioSettings();
    const ask = (k: string) => settings.cta.instagramAsk.replace('{keyword}', k);
    const generated = (keyword: string) => ({
        carousel: { ...CAROUSEL, keyword, captions: { ...CAROUSEL.captions, instagram: `Hook\n\n${ask(keyword)}\n\n#tag` } },
        campaign: { keyword, variants: [], dm: '', create: false },
    });

    it("swaps a reused secondary keyword for the campaign's first, in the carousel, caption and campaign", async () => {
        routes.push([/SELECT trigger_keyword FROM campaigns/, () => ({ rows: [{ trigger_keyword: 'متجر' }, { trigger_keyword: 'منديل, رسمة, stitch' }] })]);
        const out = await preferPrimaryKeyword(TENANT, generated('stitch'), settings);
        assert.equal(out.carousel.keyword, 'منديل');
        assert.equal(out.campaign.keyword, 'منديل');
        assert.ok(out.carousel.captions.instagram.includes(ask('منديل')));
        assert.ok(!out.carousel.captions.instagram.includes(ask('stitch')));
    });

    it('leaves a primary keyword, or one no campaign holds, as it is', async () => {
        routes.push([/SELECT trigger_keyword FROM campaigns/, () => ({ rows: [{ trigger_keyword: 'منديل, رسمة, stitch' }] })]);
        assert.equal((await preferPrimaryKeyword(TENANT, generated('منديل'), settings)).carousel.keyword, 'منديل');
        assert.equal((await preferPrimaryKeyword(TENANT, generated('دفتر'), settings)).carousel.keyword, 'دفتر');
    });
});
