/**
 * From a ready draft to scheduled posts: which rows are written with which options, when a
 * campaign is created, and how the TikTok batch staggers. The pool answers by SQL and the media
 * store is a fake, so nothing is published and no database is touched.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import type { CarouselDraftRow } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { setMediaStore, type MediaStore } from '../storage.js';
import type { Carousel } from './carouselTypes.js';
import { StudioError } from './common.js';
import { BATCH_STAGGER_MS, runTikTokBatch, scheduleDraft } from './schedule.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DRAFT = '77777777-7777-4777-8777-777777777777';
const GROUP = '99999999-9999-4999-8999-999999999999';
const uploadId = (prefix: string) => `${prefix}111111-1111-4111-8111-111111111111`;
const IG1 = uploadId('a1');
const IG2 = uploadId('a2');
const TT1 = uploadId('b1');
const TT2 = uploadId('b2');
const PNG = uploadId('d1');
const up = (id: string) => `https://msg-response-auto.vercel.app/api/uploads/${id}`;
const MIMES: Record<string, string> = {
    [IG1]: 'image/jpeg', [IG2]: 'image/jpeg', [TT1]: 'image/jpeg', [TT2]: 'image/jpeg', [PNG]: 'image/png',
};
const WHEN = '2026-10-01T10:00:00.000Z';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CAROUSEL: Carousel = {
    id: 'NotebookTips', accent: '#22C7F0', keyword: 'دفتر',
    slides: [{ kind: 'cover', title: 'عنوان' }, { kind: 'cta' }],
    captions: { instagram: 'اكتب "دفتر" بالتعليقات', tiktokTitle: 'دفترك الذكي', tiktok: 'رابطه في البايو 🔗' },
};

function draftRow(fields: Partial<CarouselDraftRow> = {}): CarouselDraftRow {
    const now = new Date();
    return {
        id: DRAFT, creator_id: TENANT, status: 'ready', input: { lessonIds: [] },
        carousel: CAROUSEL, shots: {},
        campaign: { keyword: 'دفتر', variants: ['الدفتر'], dm: 'هلا {username}', create: true },
        render: { ig: [up(IG1), up(IG2)], tt: [up(TT1), up(TT2)], rendered_at: 'x', job_id: 'job-1' },
        schedule: null, error: null, created_at: now, updated_at: now, ...fields,
    };
}

type Rows = { rows: any[]; rowCount?: number };
let statements: { sql: string; params: any[] }[] = [];
let routes: [RegExp, (params: any[]) => Rows][] = [];
let settings: Record<string, string> = {};
let connection: Record<string, unknown> | null = null;
let draft: CarouselDraftRow = draftRow();
let lockedStatus = 'ready';
let campaigns: Record<string, unknown>[] = [];
let queued: CarouselDraftRow[] = [];
const original = { query: pool.query, connect: pool.connect };
let previousStore: MediaStore | null = null;
let restoreSink: (() => void) | undefined;

before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    statements = [];
    settings = {};
    connection = null;
    draft = draftRow();
    lockedStatus = 'ready';
    campaigns = [];
    queued = [];
    routes = [
        [/^SELECT \* FROM carousel_drafts WHERE id = \$1 AND creator_id = \$2$/, () => ({ rows: [draft] })],
        [/FROM app_settings/, (p) => ({ rows: settings[p[0]] === undefined ? [] : [{ value: settings[p[0]], is_secret: false }] })],
        [/FROM platform_connections/, () => ({ rows: connection ? [connection] : [] })],
        [/^SELECT \* FROM campaigns WHERE creator_id = \$1 AND is_active = TRUE/, () => ({ rows: campaigns })],
        [/^SELECT status, render FROM carousel_drafts/, () => ({ rows: [{ status: lockedStatus, render: draft.render }] })],
        [/^INSERT INTO scheduled_posts/, (p) => ({
            rows: [{
                id: `row-${p[1]}-${statements.filter((s) => /^INSERT INTO scheduled_posts/.test(s.sql)).length}`,
                platform: p[1], caption: p[2], media_url: p[3], media_urls: p[4], scheduled_time: p[5], group_id: p[6],
                platform_options: p[7] ? JSON.parse(p[7]) : null,
            }],
        })],
        [/^INSERT INTO campaigns/, (p) => ({ rows: [{ id: 'campaign-1', trigger_keyword: p[1] }] })],
        [/^UPDATE carousel_drafts SET status = 'scheduled'/, (p) => ({ rows: [draftRow({ status: 'scheduled', schedule: JSON.parse(p[2]) })] })],
        [/^SELECT \* FROM carousel_drafts WHERE creator_id = \$1 AND status = 'scheduled'/, () => ({ rows: queued })],
        [/^SELECT group_id FROM scheduled_posts/, () => ({ rows: [{ group_id: GROUP }] })],
    ];
    const run = async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        statements.push({ sql: flat, params });
        const route = routes.find(([pattern]) => pattern.test(flat));
        const r = route ? route[1](params) : { rows: [] };
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };
    (pool as unknown as { query: unknown }).query = run;
    (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release() {} });
    previousStore = setMediaStore({
        async put() { throw new Error('nothing uploads here'); },
        async get() { return null; },
        async mimeTypes(ids) { return new Map(ids.filter((id) => MIMES[id]).map((id) => [id, MIMES[id]!])); },
        publicUrl: (id, origin) => `${origin}/api/uploads/${id}`,
    });
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = original.query;
    (pool as unknown as { connect: unknown }).connect = original.connect;
    setMediaStore(previousStore);
});

const inserts = () => statements.filter((s) => /^INSERT INTO scheduled_posts/.test(s.sql));
const isStudioError = (status: number) => (err: unknown) => err instanceof StudioError && err.status === status;

/** Direct Post available: the scope on the connection, and the operator's switch. */
function directPostReady(audited: boolean) {
    settings['tiktok.direct_post_enabled'] = 'true';
    if (audited) settings['tiktok.audited'] = 'true';
    connection = { id: 'conn-1', creator_id: TENANT, status: 'active', scopes: ['user.info.basic', 'video.upload', 'video.publish'] };
}

describe('scheduleDraft', () => {
    it('creates the both + carousel row from render.ig, with the Instagram caption and a new group', async () => {
        const outcome = await scheduleDraft(TENANT, DRAFT, { scheduled_time: WHEN, tiktok: 'none', create_campaign: false });

        const [meta] = inserts();
        assert.equal(inserts().length, 1);
        assert.match(meta!.sql, /VALUES \(\$1, \$2, 'carousel', \$3, \$4, \$5::text\[\], \$6, 'PENDING', NULL, \$7, \$8::jsonb\)/);
        const [creator, platform, caption, mediaUrl, mediaUrls, when, groupId, options] = meta!.params;
        assert.equal(creator, TENANT);
        assert.equal(platform, 'both');
        assert.equal(caption, CAROUSEL.captions.instagram);
        assert.equal(mediaUrl, up(IG1), 'media_url mirrors the first slide');
        assert.deepEqual(mediaUrls, [up(IG1), up(IG2)]);
        assert.equal((when as Date).toISOString(), WHEN);
        assert.match(groupId, UUID);
        assert.equal(options, null);

        assert.equal(outcome.draft.status, 'scheduled');
        assert.deepEqual(outcome.draft.schedule, {
            scheduled_time: WHEN, meta_row_id: outcome.rows[0]!.id, tiktok: 'none', tiktok_row_id: null, tiktok_public_done: false,
        });
        assert.equal(outcome.campaign, null);
        assert.ok(!statements.some((s) => /INSERT INTO campaigns/.test(s.sql)));
    });

    it('records a queued TikTok post as intent only — the batch makes its row', async () => {
        const outcome = await scheduleDraft(TENANT, DRAFT, { scheduled_time: WHEN, tiktok: 'queue' });
        assert.equal(inserts().length, 1);
        assert.equal(outcome.draft.schedule?.tiktok, 'queue');
        assert.equal(outcome.draft.schedule?.tiktok_row_id, null);
    });

    it('adds the TikTok sibling at the same time once audited: direct, public, the carousel’s own title', async () => {
        directPostReady(true);
        const outcome = await scheduleDraft(TENANT, DRAFT, { scheduled_time: WHEN, tiktok: 'scheduled' });

        const [meta, tiktok] = inserts();
        assert.equal(inserts().length, 2);
        assert.equal(tiktok!.params[1], 'tiktok');
        assert.equal(tiktok!.params[2], CAROUSEL.captions.tiktok);
        assert.deepEqual(tiktok!.params[4], [up(TT1), up(TT2)], 'the 9:16 slides, not the 4:5 ones');
        assert.equal(tiktok!.params[6], meta!.params[6], 'one group, so Posts shows them together');
        const options = JSON.parse(tiktok!.params[7]);
        assert.equal(options.mode, 'direct');
        assert.equal(options.privacy_level, 'PUBLIC_TO_EVERYONE');
        assert.equal(options.title, CAROUSEL.captions.tiktokTitle);
        assert.equal(options.auto_add_music, true);
        assert.equal(options.allow_comment, true);
        assert.equal(options.brand_organic, true);
        assert.equal(options.brand_content, false);
        assert.ok(options.consent_at, 'the operator’s click is the consent, and it is stamped');
        assert.ok(!('allow_duet' in options), 'a photo post has no duet');
        assert.equal(outcome.draft.schedule?.tiktok_row_id, outcome.rows[1]!.id);
    });

    it('refuses tiktok=scheduled until TikTok has audited the app, writing nothing', async () => {
        directPostReady(false);
        await assert.rejects(scheduleDraft(TENANT, DRAFT, { scheduled_time: WHEN, tiktok: 'scheduled' }), isStudioError(409));
        assert.equal(inserts().length, 0);
    });

    it('refuses tiktok=scheduled when the connection cannot Direct Post', async () => {
        directPostReady(true);
        connection = { ...connection, scopes: ['user.info.basic', 'video.upload'] };
        await assert.rejects(scheduleDraft(TENANT, DRAFT, { scheduled_time: WHEN, tiktok: 'scheduled' }), isStudioError(409));
        assert.equal(inserts().length, 0);
    });

    it('refuses a draft whose slides are not rendered yet', async () => {
        draft = draftRow({ status: 'rendering' });
        await assert.rejects(scheduleDraft(TENANT, DRAFT, { scheduled_time: WHEN }), isStudioError(409));
    });

    it('refuses a slide Instagram would refuse, with the composer’s sentence', async () => {
        draft = draftRow({ render: { ig: [up(PNG), up(IG2)], tt: [up(TT1), up(TT2)], rendered_at: 'x', job_id: 'job-1' } });
        await assert.rejects(scheduleDraft(TENANT, DRAFT, { scheduled_time: WHEN }), isStudioError(400));
        assert.equal(inserts().length, 0);
    });

    it('refuses a time it cannot read', async () => {
        await assert.rejects(scheduleDraft(TENANT, DRAFT, { scheduled_time: 'tomorrow' }), isStudioError(400));
        await assert.rejects(scheduleDraft(TENANT, DRAFT, { scheduled_time: WHEN, tiktok: 'later' }), isStudioError(400));
    });

    it('schedules once when two clicks race: the locked re-check finds it no longer ready', async () => {
        lockedStatus = 'scheduled';
        await assert.rejects(scheduleDraft(TENANT, DRAFT, { scheduled_time: WHEN }), isStudioError(409));
        assert.equal(inserts().length, 0);
    });
});

describe('scheduleDraft — the campaign', () => {
    it('creates it exactly as POST /campaigns does: keyword and variants, the DM, every post, default mode', async () => {
        const outcome = await scheduleDraft(TENANT, DRAFT, { scheduled_time: WHEN, create_campaign: true });
        const [insert] = statements.filter((s) => /^INSERT INTO campaigns/.test(s.sql));
        assert.equal(insert!.sql,
            "INSERT INTO campaigns (creator_id, trigger_keyword, dm_template, public_reply_template, post_id, is_active, match_mode) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'substring')) RETURNING *");
        assert.deepEqual(insert!.params, [TENANT, 'دفتر, الدفتر', 'هلا {username}', null, null, true, null]);
        assert.deepEqual(outcome.campaign, { id: 'campaign-1', trigger_keyword: 'دفتر, الدفتر', created: true });
    });

    it('reuses an active campaign that already answers the keyword — including a shorter substring one', async () => {
        campaigns = [{ id: 'old-1', trigger_keyword: 'store, دفت', is_active: true, post_id: null, match_mode: 'substring', created_at: new Date() }];
        const outcome = await scheduleDraft(TENANT, DRAFT, { scheduled_time: WHEN, create_campaign: true });
        assert.ok(!statements.some((s) => /^INSERT INTO campaigns/.test(s.sql)));
        assert.deepEqual(outcome.campaign, { id: 'old-1', trigger_keyword: 'store, دفت', created: false });
    });

    it('does not count a campaign tied to another post: it would never answer this one', async () => {
        campaigns = [{ id: 'old-2', trigger_keyword: 'دفتر', is_active: true, post_id: 'ig-post-1', match_mode: 'substring', created_at: new Date() }];
        const outcome = await scheduleDraft(TENANT, DRAFT, { scheduled_time: WHEN, create_campaign: true });
        assert.equal(outcome.campaign?.created, true);
    });
});

describe('runTikTokBatch', () => {
    const NOW = Date.parse('2026-10-01T09:00:00Z');
    const queuedDraft = (id: string, tt: string[]) => draftRow({
        id, status: 'scheduled',
        render: { ig: [up(IG1), up(IG2)], tt, rendered_at: 'x', job_id: 'job-1' },
        schedule: { scheduled_time: WHEN, meta_row_id: `meta-${id}`, tiktok: 'queue', tiktok_row_id: null, tiktok_public_done: false },
    });
    const D1 = 'd1d1d1d1-1111-4111-8111-111111111111';
    const D2 = 'd2d2d2d2-2222-4222-8222-222222222222';
    const D3 = 'd3d3d3d3-3333-4333-8333-333333333333';

    it('turns every queued draft into a TikTok row due now, 40 seconds apart, private while unaudited', async () => {
        directPostReady(false);
        queued = [queuedDraft(D1, [up(TT1), up(TT2)]), queuedDraft(D2, [up(TT1), up(TT2)]), queuedDraft(D3, [up(TT1), up(TT2)])];
        const outcome = await runTikTokBatch(TENANT, NOW);
        assert.equal(outcome.queued, 3);
        assert.deepEqual(outcome.skipped, []);

        const rows = inserts();
        assert.deepEqual(rows.map((r) => (r.params[5] as Date).getTime()), [NOW, NOW + BATCH_STAGGER_MS, NOW + 2 * BATCH_STAGGER_MS]);
        assert.equal(BATCH_STAGGER_MS, 40_000);
        for (const row of rows) {
            assert.equal(row.params[1], 'tiktok');
            assert.equal(row.params[6], GROUP, 'the Meta sibling’s group');
            const options = JSON.parse(row.params[7]);
            assert.equal(options.mode, 'direct');
            assert.equal(options.privacy_level, 'SELF_ONLY');
            assert.equal(options.title, CAROUSEL.captions.tiktokTitle);
            assert.equal(options.auto_add_music, true);
            assert.equal(options.allow_comment, true);
            assert.equal(options.brand_organic, true);
        }

        const marks = statements.filter((s) => /^UPDATE carousel_drafts SET schedule = jsonb_set\(schedule, '\{tiktok_row_id\}'/.test(s.sql));
        assert.deepEqual(marks.map((m) => [m.params[0], m.params[2]]), [
            [D1, outcome.rows[0]!.id], [D2, outcome.rows[1]!.id], [D3, outcome.rows[2]!.id],
        ]);

        // Locked, so a second click waits and then finds nothing left to queue.
        const [select] = statements.filter((s) => /^SELECT \* FROM carousel_drafts WHERE creator_id = \$1 AND status = 'scheduled'/.test(s.sql));
        assert.match(select!.sql, /schedule->>'tiktok' = 'queue' AND schedule->>'tiktok_row_id' IS NULL/);
        assert.match(select!.sql, /FOR UPDATE$/);
    });

    it('goes public once audited', async () => {
        directPostReady(true);
        queued = [queuedDraft(D1, [up(TT1), up(TT2)])];
        await runTikTokBatch(TENANT, NOW);
        assert.equal(JSON.parse(inserts()[0]!.params[7]).privacy_level, 'PUBLIC_TO_EVERYONE');
    });

    it('skips a draft TikTok would refuse, says why, and keeps the rest 40 seconds apart', async () => {
        directPostReady(false);
        queued = [queuedDraft(D1, [up(TT1), up(TT2)]), queuedDraft(D2, [up(PNG), up(TT2)]), queuedDraft(D3, [up(TT1), up(TT2)])];
        const outcome = await runTikTokBatch(TENANT, NOW);
        assert.equal(outcome.queued, 2);
        assert.equal(outcome.skipped.length, 1);
        assert.equal(outcome.skipped[0]!.draftId, D2);
        assert.deepEqual(inserts().map((r) => (r.params[5] as Date).getTime()), [NOW, NOW + BATCH_STAGGER_MS]);
    });

    it('refuses outright when TikTok cannot Direct Post, before locking anything', async () => {
        queued = [queuedDraft(D1, [up(TT1), up(TT2)])];
        await assert.rejects(runTikTokBatch(TENANT, NOW), isStudioError(409));
        assert.ok(!statements.some((s) => /FOR UPDATE/.test(s.sql)));
        assert.equal(inserts().length, 0);
    });
});
