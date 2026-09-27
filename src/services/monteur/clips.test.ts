/**
 * A reel from the review queue to the scheduler (MONTEUR.md §5, §6.1): which rows Approve writes
 * with which options, which slot it takes, when the campaign is made, what an edit re-renders,
 * and what Reject removes. The pool answers by SQL, with a scheduled_posts list that honours the
 * slot query's platforms, so "two approvals take two slots" is observed. Nothing is published.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { ClipCopy } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { StudioError } from '../studio/common.js';
import { ELAMIR_SETTINGS } from '../studio/testFixtures.js';
import { approveClip, localDay, metaPlatformFor, patchClip, rejectClip, rerenderClip, slotHolders } from './clips.js';
import { installFakeDb, type FakeDb } from './testDb.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIP = '77777777-7777-4777-8777-777777777777';
const SOURCE = '66666666-6666-4666-8666-666666666666';
const VIDEO = 'a1111111-1111-4111-8111-111111111111';
const TT_VIDEO = 'e1111111-1111-4111-8111-111111111111';
const COVER = 'b1111111-1111-4111-8111-111111111111';
const up = (id: string) => `https://msg-response-auto.vercel.app/api/uploads/${id}`;
const LINK = '📚 الكورس كامل بالعربي — رابطه في البايو 🔗';
const NOW = Date.parse('2026-09-27T09:00:00Z'); // 12:00 in Riyadh

const COPY: ClipCopy = {
    caption: '🔥 دفترك الذكي\n\nتبي الرابط؟ اكتب «دفتر» ويوصلك بالخاص 📩\n\n#ai #دفتر_ذكي',
    tiktok_caption: `🔥 دفترك الذكي\n\n${LINK}\n\n#ai #تعلم_على_تيك_توك`,
    hashtags: ['ai', 'دفتر_ذكي'],
    keyword: 'دفتر',
    variants: ['دفاتر'],
    keyword_create: true,
    dm: 'هلا {username} 👋',
    alt_text: 'متحدث يشرح NotebookLM',
};
const RENDER = { video_url: up(VIDEO), tiktok_video_url: up(TT_VIDEO), cover_url: up(COVER), duration: 31.2, job_id: 'job-1', rendered_at: 'x' };

let db: FakeDb;
let clip: Record<string, unknown>;
/** What the locked re-read sees, when it differs from the first read: a second click that won. */
let lockedStatus: string | null;
let lockedCopy: ClipCopy | null;
let monteur: Record<string, unknown>;
let appSettings: Record<string, string>;
let connection: Record<string, unknown> | null;
let campaigns: Record<string, unknown>[];
let posts: { platform: string; scheduled_time: Date; status: string }[];
let siblings: { t: string }[];
let inFlight: string[];
let restoreSink: (() => void) | undefined;

before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    db = installFakeDb();
    clip = {
        id: CLIP, creator_id: TENANT, source_id: SOURCE, rank: 1, status: 'review', start_s: 12.35, end_s: 43.8,
        title: 'دفترك الذكي', hook: 'تبي دفتر يفهمك؟', why: 'hook', score: 8, topic: 'NotebookLM', hook_type: 'promise',
        scores: { hook: 3, alone: 3, payoff: 2, send: 2 }, text: 'تبي دفتر يفهمك', copy: COPY, render: RENDER, schedule: null,
        error: null, created_at: new Date(), updated_at: new Date(),
    };
    lockedStatus = null;
    lockedCopy = null;
    monteur = { platforms: ['instagram', 'facebook', 'tiktok'], post_at: ['19:00'] };
    appSettings = {};
    connection = null;
    campaigns = [];
    posts = [];
    siblings = [];
    inFlight = [];
    db.routes.push(
        [/^UPDATE clip_drafts c SET status = 'review', schedule = NULL/, () => ({ rows: [], rowCount: 0 })],
        [/^SELECT id, status, render FROM clip_drafts/, () => ({ rows: [clip] })],
        [/FROM studio_settings/, () => ({ rows: [{ ...ELAMIR_SETTINGS, monteur: { ...ELAMIR_SETTINGS.monteur, ...monteur } }] })],
        [/FROM app_settings/, (p) => ({ rows: appSettings[p[0]] === undefined ? [] : [{ value: appSettings[p[0]], is_secret: false }] })],
        [/FROM platform_connections/, () => ({ rows: connection ? [connection] : [] })],
        [/^SELECT \* FROM campaigns WHERE creator_id = \$1 AND is_active = TRUE/, () => ({ rows: campaigns })],
        [/^SELECT trigger_keyword FROM campaigns/, () => ({ rows: campaigns })],
        [/^SELECT id, creator_id, source_id, rank, status, start_s::float8/, () => ({
            rows: [{ ...clip, status: lockedStatus ?? clip.status, copy: lockedCopy ?? clip.copy }],
        })],
        [/^SELECT schedule->>'scheduled_time' AS t FROM clip_drafts/, () => ({ rows: siblings })],
        [/^SELECT DISTINCT copy->>'keyword' AS keyword FROM clip_drafts/, () => ({ rows: inFlight.map((keyword) => ({ keyword })) })],
        [/^SELECT scheduled_time FROM scheduled_posts/, (p) => ({
            rows: posts.filter((r) => r.status === 'PENDING' && (p[3] as string[]).includes(r.platform)).map((r) => ({ scheduled_time: r.scheduled_time })),
        })],
        [/^INSERT INTO scheduled_posts/, (p) => {
            posts.push({ platform: p[1], scheduled_time: p[4], status: 'PENDING' });
            return { rows: [{ id: `row-${p[1]}-${posts.length}`, platform: p[1], group_id: p[6] }] };
        }],
        [/^INSERT INTO campaigns/, (p) => ({ rows: [{ id: 'campaign-1', trigger_keyword: p[1] }] })],
        [/^SELECT c\.id, c\.source_id, s\.name AS source_name/, () => ({ rows: [{ ...clip, source_name: 'lesson.mp4' }] })],
        [/^SELECT id, path, words FROM monteur_sources/, () => ({ rows: [{ id: SOURCE, path: '/v/lesson.mp4', words: [[12.5, 13, 'تبي'], [13.1, 13.5, 'دفتر']] }] })],
        [/^INSERT INTO studio_jobs/, (p) => ({ rows: [{ id: 'job-2', kind: p[1], status: 'pending', payload: JSON.parse(p[2]) }] })],
    );
});
afterEach(() => db.restore());

const inserts = () => db.ran(/^INSERT INTO scheduled_posts/);
const isStudioError = (status: number) => (err: unknown) => err instanceof StudioError && err.status === status;
function directPostReady(audited: boolean) {
    appSettings['tiktok.direct_post_enabled'] = 'true';
    if (audited) appSettings['tiktok.audited'] = 'true';
    connection = { id: 'conn-1', creator_id: TENANT, status: 'active', scopes: ['user.info.basic', 'video.upload', 'video.publish'] };
}

describe('approveClip — the rows', () => {
    it('writes one both + video row with the reel, its cover and the caption, and a TikTok sibling with its own cut', async () => {
        directPostReady(false);
        const outcome = await approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' }, NOW);

        const [meta, tiktok] = inserts();
        assert.equal(inserts().length, 2);
        assert.match(meta!.sql, /VALUES \(\$1, \$2, 'video', \$3, \$4, NULL, \$5, 'PENDING', \$6, \$7, \$8::jsonb, NULL\)/);
        assert.deepEqual(meta!.params.slice(0, 4), [TENANT, 'both', COPY.caption, up(VIDEO)]);
        assert.equal((meta!.params[4] as Date).toISOString(), '2026-10-01T16:00:00.000Z');
        assert.equal(meta!.params[5], up(COVER));
        assert.equal(meta!.params[7], null, 'the Meta row carries no TikTok options');

        assert.deepEqual(tiktok!.params.slice(0, 4), [TENANT, 'tiktok', COPY.tiktok_caption, up(TT_VIDEO)], 'TikTok’s cut, whose CTA says link in bio');
        assert.equal(tiktok!.params[5], null, 'TikTok picks its own cover');
        assert.equal(tiktok!.params[6], meta!.params[6], 'one group, so Posts shows them together');
        const options = JSON.parse(tiktok!.params[7]);
        assert.equal(options.mode, 'direct');
        assert.equal(options.privacy_level, 'SELF_ONLY', 'private until TikTok audits the app, as the owner chose');
        assert.equal(options.allow_comment, true);
        assert.equal(options.brand_organic, true);
        assert.equal(options.allow_duet, false);
        assert.ok(options.consent_at);
        assert.ok(!('title' in options) && !('auto_add_music' in options), 'those are a photo post’s');

        const [update] = db.ran(/^UPDATE clip_drafts SET status = 'scheduled'/);
        assert.deepEqual(JSON.parse(update!.params[2]), {
            scheduled_time: '2026-10-01T16:00:00.000Z', meta_row_id: 'row-both-1', tiktok_row_id: 'row-tiktok-2',
            campaign_id: 'campaign-1', tiktok_privacy: 'SELF_ONLY',
        });
        assert.equal(outcome.scheduled_time, '2026-10-01T16:00:00.000Z');
    });

    it('falls back to the main video for TikTok when there is no TikTok cut', async () => {
        directPostReady(true);
        clip = { ...clip, render: { ...RENDER, tiktok_video_url: null } };
        await approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' }, NOW);
        assert.equal(inserts()[1]!.params[3], up(VIDEO));
        assert.equal(JSON.parse(inserts()[1]!.params[7]).privacy_level, 'PUBLIC_TO_EVERYONE', 'public once audited');
    });

    it('posts the copy as it is under the lock, not as it was first read', async () => {
        monteur = { platforms: ['instagram'], post_at: ['19:00'] };
        lockedCopy = { ...COPY, caption: '🔥 edited a moment ago\n\nتبي الرابط؟ اكتب «دفتر» 📩' };
        await approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' }, NOW);
        assert.equal(inserts()[0]!.params[2], lockedCopy.caption);
        const order = db.statements.map((s) => s.sql);
        const lock = order.findIndex((s) => /pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/.test(s));
        assert.ok(lock >= 0 && lock < order.findIndex((s) => /FOR UPDATE/.test(s)), 'the tenant lock comes first');
        assert.equal(db.ran(/pg_advisory_xact_lock/)[0]!.params[0], `monteur.approve:${TENANT}`);
    });

    it('posts to one Meta platform, or none, as the platforms say', async () => {
        assert.equal(metaPlatformFor(['instagram', 'facebook']), 'both');
        assert.equal(metaPlatformFor(['facebook', 'tiktok']), 'facebook');
        assert.equal(metaPlatformFor(['tiktok']), null);

        monteur = { platforms: ['instagram'], post_at: ['19:00'] };
        await approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' }, NOW);
        assert.deepEqual(inserts().map((p) => p.params[1]), ['instagram']);

        db.statements.length = 0;
        monteur = { platforms: ['tiktok'], post_at: ['19:00'] };
        directPostReady(true);
        await approveClip(TENANT, CLIP, { scheduled_time: '2026-10-02T16:00:00Z' }, NOW);
        assert.deepEqual(inserts().map((p) => p.params[1]), ['tiktok']);
        assert.equal(db.ran(/FROM campaigns/).length, 0, 'a DM campaign answers Instagram and Facebook only');
    });

    it('409s unless the reel is in review, at the first read, before any other work', async () => {
        for (const status of ['rendering', 'scheduled', 'rejected', 'failed']) {
            clip = { ...clip, status };
            await assert.rejects(approveClip(TENANT, CLIP, {}, NOW), isStudioError(409), status);
        }
        assert.equal(inserts().length, 0);
        assert.equal(db.ran(/FROM studio_settings|FOR UPDATE/).length, 0, 'no slot looked for, no transaction opened');
    });

    it('frees a scheduled reel whose posts are gone before deciding', async () => {
        await approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' }, NOW).catch(() => undefined);
        const [release] = db.ran(/^UPDATE clip_drafts c SET status = 'review', schedule = NULL/);
        assert.deepEqual(release!.params, [TENANT, CLIP]);
        assert.match(release!.sql, /NOT EXISTS \( SELECT 1 FROM scheduled_posts p WHERE p\.creator_id = c\.creator_id AND p\.status <> 'FAILED'/);
        assert.ok(db.statements.findIndex((s) => /SET status = 'review', schedule = NULL/.test(s.sql))
            < db.statements.findIndex((s) => /^SELECT id, status, render FROM clip_drafts/.test(s.sql)));
    });

    it('refuses, before writing, when TikTok is on but cannot Direct Post', async () => {
        await assert.rejects(approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' }, NOW), (err: unknown) =>
            err instanceof StudioError && err.status === 409 && /take TikTok off the Monteur's platforms/.test(err.message));
        assert.equal(inserts().length, 0);
    });

    it('schedules once when two clicks race: the locked re-check finds it no longer in review', async () => {
        monteur = { platforms: ['instagram'], post_at: ['19:00'] };
        lockedStatus = 'scheduled';
        await assert.rejects(approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' }, NOW), isStudioError(409));
        assert.equal(inserts().length, 0);
    });

    it('refuses a time it cannot read', async () => {
        await assert.rejects(approveClip(TENANT, CLIP, { scheduled_time: 'tomorrow' }, NOW), isStudioError(400));
    });
});

describe('approveClip — the slot', () => {
    it('takes the next free slot: 19:00 Riyadh is 16:00Z', async () => {
        monteur = { platforms: ['instagram'], post_at: ['19:00'] };
        const outcome = await approveClip(TENANT, CLIP, {}, NOW);
        assert.equal(outcome.scheduled_time, '2026-09-27T16:00:00.000Z');
    });

    it('gives two TikTok-only approvals two slots: its TikTok rows hold them', async () => {
        assert.deepEqual(slotHolders(['tiktok']), ['tiktok']);
        assert.deepEqual(slotHolders(['instagram', 'tiktok']), ['instagram', 'facebook', 'both']);
        monteur = { platforms: ['tiktok'], post_at: ['19:00'] };
        directPostReady(true);
        const first = await approveClip(TENANT, CLIP, {}, NOW);
        const second = await approveClip(TENANT, CLIP, {}, NOW);
        assert.equal(first.scheduled_time, '2026-09-27T16:00:00.000Z');
        assert.equal(second.scheduled_time, '2026-09-28T16:00:00.000Z', 'not the same instant twice');
    });

    it('never puts two reels of one video on the same day', async () => {
        monteur = { platforms: ['instagram'], post_at: ['13:00', '19:00'] };
        siblings = [{ t: '2026-09-27T10:00:00.000Z' }]; // 13:00 today, Riyadh
        const outcome = await approveClip(TENANT, CLIP, {}, NOW);
        assert.equal(localDay(Date.parse(outcome.scheduled_time), 'Asia/Riyadh'), '2026-09-28', 'today’s 19:00 is free, but the video is already on today');
        assert.equal(outcome.scheduled_time, '2026-09-28T10:00:00.000Z');

        await assert.rejects(approveClip(TENANT, CLIP, { scheduled_time: '2026-09-27T16:00:00Z' }, NOW), (err: unknown) =>
            err instanceof StudioError && err.status === 409 && /another reel from this video is already on 2026-09-27/.test(err.message));
    });
});

describe('approveClip — the campaign', () => {
    beforeEach(() => { monteur = { platforms: ['instagram', 'facebook'], post_at: ['19:00'] }; });

    it('creates it as POST /campaigns does, in word mode: keyword and variants, the DM, every post', async () => {
        const outcome = await approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' }, NOW);
        const [insert] = db.ran(/^INSERT INTO campaigns/);
        assert.deepEqual(insert!.params, [TENANT, 'دفتر, دفاتر', 'هلا {username} 👋', null, null, true, 'word']);
        assert.deepEqual(outcome.campaign, { id: 'campaign-1', trigger_keyword: 'دفتر, دفاتر', created: true });
    });

    it('reuses an active campaign for every post that answers the keyword', async () => {
        campaigns = [{ id: 'old-1', trigger_keyword: 'دفت', is_active: true, post_id: null, match_mode: 'substring', created_at: new Date() }];
        const reused = await approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' }, NOW);
        assert.deepEqual(reused.campaign, { id: 'old-1', trigger_keyword: 'دفت', created: false });
        assert.equal(db.ran(/^INSERT INTO campaigns/).length, 0);
    });

    it('never asks for a keyword nothing answers: with keyword_create off, a missing campaign is still made', async () => {
        clip = { ...clip, copy: { ...COPY, keyword_create: false } };
        const outcome = await approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' }, NOW);
        assert.equal(outcome.campaign?.created, true);
        assert.equal(db.ran(/^INSERT INTO campaigns/).length, 1);
    });

    it('does not count a campaign tied to another post: it would never answer this reel', async () => {
        campaigns = [{ id: 'old-2', trigger_keyword: 'دفتر', is_active: true, post_id: 'ig-post-1', match_mode: 'substring', created_at: new Date() }];
        clip = { ...clip, copy: { ...COPY, keyword_create: false } };
        const outcome = await approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' }, NOW);
        assert.equal(outcome.campaign?.created, true);
    });

    it('refuses a keyword that sits inside a live keyword, writing nothing', async () => {
        campaigns = [{ id: 'old-3', trigger_keyword: 'الدفتر', is_active: true, post_id: null, match_mode: 'substring', created_at: new Date() }];
        await assert.rejects(approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' }, NOW), (err: unknown) =>
            err instanceof StudioError && err.status === 409 && /copy\.keyword: «دفتر» sits inside the active keyword «الدفتر»/.test(err.message));
        assert.equal(inserts().length, 0);
    });
});

describe('patchClip', () => {
    const renders = () => db.ran(/^INSERT INTO studio_jobs/);

    it('saves a caption-only change without touching the video', async () => {
        const caption = `${COPY.caption}\n\nسطر جديد`;
        await patchClip(TENANT, CLIP, { copy: { caption } });
        const [update] = db.ran(/^UPDATE clip_drafts SET title/);
        assert.equal(JSON.parse(update!.params[3]).caption, caption);
        assert.equal(renders().length, 0);
    });

    it('renders again for a new title, with the words on the clip’s clock, the same accent and both CTAs', async () => {
        db.routes.unshift([/payload->'brand'->>'accent' AS accent FROM studio_jobs WHERE creator_id = \$1 AND kind = 'monteur_render' AND payload->>'clipId'/, () => ({ rows: [{ accent: '#22C7F0' }] })]);
        await patchClip(TENANT, CLIP, { title: 'عنوان أقوى' });
        const [job] = renders();
        assert.equal(job!.params[1], 'monteur_render');
        const payload = JSON.parse(job!.params[2]);
        assert.equal(payload.title, 'عنوان أقوى');
        assert.equal(payload.brand.accent, '#22C7F0');
        assert.deepEqual(payload.words, [[0.15, 0.65, 'تبي'], [0.75, 1.15, 'دفتر']]);
        assert.deepEqual(payload.cta, { line1: 'اكتب في التعليقات «دفتر»', line2: 'ويوصلك الرابط بالخاص 📩' });
        assert.deepEqual(payload.cta_tiktok, { line1: 'رابطه في البايو', line2: 'ادخل البروفايل واضغط الرابط 👆' });
        assert.equal(payload.cover_at, 0.5);
    });

    it('sends no TikTok CTA when TikTok is off', async () => {
        monteur = { platforms: ['instagram'], post_at: ['19:00'] };
        await patchClip(TENANT, CLIP, { title: 'عنوان أقوى' });
        assert.equal(JSON.parse(renders()[0]!.params[2]).cta_tiktok, null);
    });

    it('carries a new keyword into the caption’s «keyword», drops the old variants, and renders the new CTA', async () => {
        await patchClip(TENANT, CLIP, { copy: { keyword: 'ملاحظات' } });
        const saved = JSON.parse(db.ran(/^UPDATE clip_drafts SET title/)[0]!.params[3]);
        assert.ok(saved.caption.includes('اكتب «ملاحظات» ويوصلك'), saved.caption);
        assert.ok(!saved.caption.includes('«دفتر»'));
        assert.deepEqual(saved.variants, []);
        assert.equal(saved.keyword_create, true);
        assert.match(JSON.parse(renders()[0]!.params[2]).cta.line1, /«ملاحظات»/);
    });

    it('re-renders a change of spelling too: the video shows the keyword as typed', async () => {
        await patchClip(TENANT, CLIP, { copy: { keyword: 'دفتـر' } }).catch(() => undefined);
        clip = { ...clip, copy: { ...COPY, keyword: 'Notebook', caption: 'x «Notebook» y' } };
        db.statements.length = 0;
        await patchClip(TENANT, CLIP, { copy: { keyword: 'notebook' } });
        assert.equal(renders().length, 1);
    });

    it('refuses a keyword under 4 letters, or one overlapping a live or in-flight keyword', async () => {
        await assert.rejects(patchClip(TENANT, CLIP, { copy: { keyword: 'دفت' } }), (err: unknown) =>
            err instanceof StudioError && err.status === 400 && /copy\.keyword must have at least 4 letters/.test(err.message));
        campaigns = [{ trigger_keyword: 'ملاحظات_مهمة, other' }];
        inFlight = ['برومبتات'];
        await assert.rejects(patchClip(TENANT, CLIP, { copy: { keyword: 'برومبت' } }), (err: unknown) =>
            err instanceof StudioError && err.status === 409 && (err.problems ?? []).some((p) => /^copy\.keyword: «برومبت» overlaps the active keyword «برومبتات»/.test(p)));
        assert.equal(db.ran(/^UPDATE/).length, 0);
    });

    it('accepts a keyword equal to one in flight: the two reels share the campaign', async () => {
        inFlight = ['ملاحظات'];
        await patchClip(TENANT, CLIP, { copy: { keyword: 'ملاحظات' } });
        assert.equal(renders().length, 1);
    });

    it('refuses a caption that no longer asks for «keyword», writing nothing', async () => {
        await assert.rejects(patchClip(TENANT, CLIP, { copy: { caption: 'no ask here, just دفتر' } }), (err: unknown) =>
            err instanceof StudioError && err.status === 400 && /^copy\.caption must keep the keyword ask with «دفتر»/.test(err.message));
        await assert.rejects(patchClip(TENANT, CLIP, { copy: { tiktok_caption: 'no link line' } }), (err: unknown) =>
            err instanceof StudioError && /^copy\.tiktok_caption must keep the line/.test(err.message));
        assert.equal(db.ran(/^UPDATE/).length, 0);
    });

    it('accepts any ask wording, as long as it keeps «keyword»', async () => {
        await patchClip(TENANT, CLIP, { copy: { caption: 'سطر\n\nوش رايك؟ علّق «دفتر» 👇' } });
        assert.equal(db.ran(/^UPDATE clip_drafts SET title/).length, 1);
    });

    it('does not re-render a failed clip on an unrelated edit: that is /rerender', async () => {
        clip = { ...clip, status: 'failed' };
        await patchClip(TENANT, CLIP, { copy: { dm: 'هلا {username}' } });
        assert.equal(renders().length, 0);
    });

    it('refuses a scheduled or rejected clip, a field that is not one, and a bad value', async () => {
        clip = { ...clip, status: 'scheduled' };
        await assert.rejects(patchClip(TENANT, CLIP, { title: 'x' }), isStudioError(409));
        clip = { ...clip, status: 'rejected' };
        await assert.rejects(patchClip(TENANT, CLIP, { title: 'x' }), isStudioError(409));
        clip = { ...clip, status: 'review' };
        await assert.rejects(patchClip(TENANT, CLIP, { copy: { keyword: 'two words' } }), isStudioError(400));
        await assert.rejects(patchClip(TENANT, CLIP, { copy: { colour: 'red' } }), (err: unknown) =>
            err instanceof StudioError && /^copy\.colour is not a field/.test(err.message));
        await assert.rejects(patchClip(TENANT, CLIP, { title: 'x'.repeat(61) }), isStudioError(400));
        await assert.rejects(patchClip(TENANT, CLIP, {}), isStudioError(400));
    });
});

describe('rerenderClip', () => {
    it('renders a failed clip again as it is', async () => {
        clip = { ...clip, status: 'failed' };
        await rerenderClip(TENANT, CLIP);
        const [job] = db.ran(/^INSERT INTO studio_jobs/);
        assert.equal(JSON.parse(job!.params[2]).title, 'دفترك الذكي');
    });

    it('409s any clip that has not failed', async () => {
        for (const status of ['review', 'rendering', 'scheduled', 'rejected']) {
            clip = { ...clip, status };
            await assert.rejects(rerenderClip(TENANT, CLIP), isStudioError(409), status);
        }
        assert.equal(db.ran(/^INSERT INTO studio_jobs/).length, 0);
    });
});

describe('rejectClip', () => {
    it('stops its renders, rejects it, then deletes all three files and may finish its source', async () => {
        await rejectClip(TENANT, CLIP);
        const order = db.statements.map((s) => s.sql);
        const cancel = order.findIndex((s) => /^UPDATE studio_jobs SET status = 'failed'.*kind = 'monteur_render' AND status = 'pending'/.test(s));
        const reject = order.findIndex((s) => /^UPDATE clip_drafts SET status = 'rejected'/.test(s));
        const del = order.findIndex((s) => /^DELETE FROM media_uploads/.test(s));
        assert.ok(cancel >= 0 && reject > cancel && del > reject, 'deleted only once the clip no longer names them');
        assert.deepEqual(db.statements[del]!.params, [TENANT, [VIDEO, TT_VIDEO, COVER]]);
        assert.ok(order.some((s) => /^UPDATE monteur_sources s SET status = 'done'/.test(s)));
    });

    it('dismisses a failed clip', async () => {
        clip = { ...clip, status: 'failed', render: null };
        await rejectClip(TENANT, CLIP);
        assert.equal(db.ran(/^UPDATE clip_drafts SET status = 'rejected'/).length, 1);
    });

    it('refuses a scheduled reel, and is a no-op on one already rejected', async () => {
        clip = { ...clip, status: 'scheduled' };
        await assert.rejects(rejectClip(TENANT, CLIP), isStudioError(409));
        clip = { ...clip, status: 'rejected' };
        db.statements.length = 0;
        await rejectClip(TENANT, CLIP);
        assert.equal(db.ran(/^(UPDATE|DELETE)/).length, 0);
    });
});
