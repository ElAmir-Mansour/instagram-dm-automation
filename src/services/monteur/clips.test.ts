/**
 * A reel from the review queue to the scheduler (MONTEUR.md §5): which rows Approve writes with
 * which options, when the campaign is made, what an edit re-renders, and what Reject removes.
 * The pool answers by SQL; nothing is published and no model is called.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { ClipCopy } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { StudioError } from '../studio/common.js';
import { ELAMIR_SETTINGS } from '../studio/testFixtures.js';
import { approveClip, metaPlatformFor, patchClip, rejectClip } from './clips.js';
import { installFakeDb, type FakeDb } from './testDb.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIP = '77777777-7777-4777-8777-777777777777';
const SOURCE = '66666666-6666-4666-8666-666666666666';
const VIDEO = 'a1111111-1111-4111-8111-111111111111';
const COVER = 'b1111111-1111-4111-8111-111111111111';
const up = (id: string) => `https://msg-response-auto.vercel.app/api/uploads/${id}`;
const ASK = 'اكتب "دفتر" بالتعليقات ويوصلك رابط الكورس بالخاص 📩';
const LINK = '📚 الكورس كامل بالعربي — رابطه في البايو 🔗';

const COPY: ClipCopy = {
    caption: `🔥 دفترك الذكي\n\n${ASK}\n\n#ai #notebooklm`,
    tiktok_caption: `🔥 دفترك الذكي\n\n${LINK}\n\n#ai #تعلم_على_تيك_توك`,
    hashtags: ['ai', 'notebooklm'],
    keyword: 'دفتر',
    variants: ['الدفتر'],
    keyword_create: true,
    dm: 'هلا {username} 👋',
    alt_text: 'A creator shows NotebookLM',
};
const RENDER = { video_url: up(VIDEO), cover_url: up(COVER), duration: 31.2, job_id: 'job-1', rendered_at: 'x' };

let db: FakeDb;
let clip: Record<string, unknown>;
/** What the locked re-read sees, when it differs from the first read: a second click that won. */
let lockedStatus: string | null;
let monteur: Record<string, unknown>;
let appSettings: Record<string, string>;
let connection: Record<string, unknown> | null;
let campaigns: Record<string, unknown>[];
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
        title: 'دفترك الذكي', hook: 'تبي دفتر يفهمك؟', why: 'hook', score: 8, copy: COPY, render: RENDER, schedule: null,
        error: null, created_at: new Date(), updated_at: new Date(),
    };
    lockedStatus = null;
    monteur = { platforms: ['instagram', 'facebook', 'tiktok'], post_at: ['19:00'] };
    appSettings = {};
    connection = null;
    campaigns = [];
    db.routes.push(
        [/^SELECT id, status, copy, render FROM clip_drafts/, () => ({ rows: [clip] })],
        [/FROM studio_settings/, () => ({ rows: [{ ...ELAMIR_SETTINGS, monteur }] })],
        [/FROM app_settings/, (p) => ({ rows: appSettings[p[0]] === undefined ? [] : [{ value: appSettings[p[0]], is_secret: false }] })],
        [/FROM platform_connections/, () => ({ rows: connection ? [connection] : [] })],
        [/^SELECT \* FROM campaigns WHERE creator_id = \$1 AND is_active = TRUE/, () => ({ rows: campaigns })],
        [/^SELECT id, creator_id, source_id, rank, status, start_s::float8/, () => ({ rows: [{ ...clip, status: lockedStatus ?? clip.status }] })],
        [/^INSERT INTO scheduled_posts/, (p) => ({ rows: [{ id: `row-${p[1]}`, platform: p[1], group_id: p[6] }] })],
        [/^INSERT INTO campaigns/, (p) => ({ rows: [{ id: 'campaign-1', trigger_keyword: p[1] }] })],
        [/^SELECT c\.id, c\.source_id, s\.name AS source_name/, () => ({ rows: [{ ...clip, source_name: 'lesson.mp4' }] })],
        [/^SELECT id, path, words FROM monteur_sources/, () => ({ rows: [{ id: SOURCE, path: '/v/lesson.mp4', words: [[12.5, 13, 'تبي'], [13.1, 13.5, 'دفتر']] }] })],
        [/^INSERT INTO studio_jobs/, (p) => ({ rows: [{ id: 'job-2', kind: p[1], status: 'pending', payload: JSON.parse(p[2]) }] })],
    );
});
afterEach(() => db.restore());

const posts = () => db.ran(/^INSERT INTO scheduled_posts/);
const isStudioError = (status: number) => (err: unknown) => err instanceof StudioError && err.status === status;
function directPostReady(audited: boolean) {
    appSettings['tiktok.direct_post_enabled'] = 'true';
    if (audited) appSettings['tiktok.audited'] = 'true';
    connection = { id: 'conn-1', creator_id: TENANT, status: 'active', scopes: ['user.info.basic', 'video.upload', 'video.publish'] };
}

describe('approveClip', () => {
    it('writes one both + video row with the reel, its cover and the caption, and a TikTok sibling in the same group', async () => {
        directPostReady(false);
        const outcome = await approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' });

        const [meta, tiktok] = posts();
        assert.equal(posts().length, 2);
        assert.match(meta!.sql, /VALUES \(\$1, \$2, 'video', \$3, \$4, NULL, \$5, 'PENDING', \$6, \$7, \$8::jsonb, NULL\)/);
        assert.deepEqual(meta!.params.slice(0, 4), [TENANT, 'both', COPY.caption, up(VIDEO)]);
        assert.equal((meta!.params[4] as Date).toISOString(), '2026-10-01T16:00:00.000Z');
        assert.equal(meta!.params[5], up(COVER));
        assert.equal(meta!.params[7], null, 'the Meta row carries no TikTok options');

        assert.deepEqual(tiktok!.params.slice(0, 4), [TENANT, 'tiktok', COPY.tiktok_caption, up(VIDEO)]);
        assert.equal(tiktok!.params[5], null, 'TikTok picks its own cover');
        assert.equal(tiktok!.params[6], meta!.params[6], 'one group, so Posts shows them together');
        const options = JSON.parse(tiktok!.params[7]);
        assert.equal(options.mode, 'direct');
        assert.equal(options.privacy_level, 'SELF_ONLY', 'private until TikTok audits the app, as in the Studio');
        assert.equal(options.allow_comment, true);
        assert.equal(options.brand_organic, true);
        assert.equal(options.allow_duet, false);
        assert.ok(options.consent_at);
        assert.ok(!('title' in options) && !('auto_add_music' in options), 'those are a photo post’s');

        const [update] = db.ran(/^UPDATE clip_drafts SET status = 'scheduled'/);
        assert.deepEqual(JSON.parse(update!.params[2]), {
            scheduled_time: '2026-10-01T16:00:00.000Z', meta_row_id: 'row-both', tiktok_row_id: 'row-tiktok', campaign_id: 'campaign-1',
        });
        assert.equal(outcome.scheduled_time, '2026-10-01T16:00:00.000Z');
    });

    it('goes public on TikTok once audited', async () => {
        directPostReady(true);
        await approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' });
        assert.equal(JSON.parse(posts()[1]!.params[7]).privacy_level, 'PUBLIC_TO_EVERYONE');
    });

    it('takes the next free posting slot when no time is given: 19:00 Riyadh is 16:00Z', async () => {
        monteur = { platforms: ['instagram'], post_at: ['19:00'] };
        const outcome = await approveClip(TENANT, CLIP, {});
        assert.match(outcome.scheduled_time, /T16:00:00\.000Z$/);
        assert.ok(Date.parse(outcome.scheduled_time) > Date.now());
        const [slotQuery] = db.ran(/^SELECT scheduled_time FROM scheduled_posts/);
        assert.equal(slotQuery!.params[0], TENANT);
    });

    it('posts to one Meta platform, or none, as the platforms say', async () => {
        assert.equal(metaPlatformFor(['instagram', 'facebook']), 'both');
        assert.equal(metaPlatformFor(['facebook', 'tiktok']), 'facebook');
        assert.equal(metaPlatformFor(['tiktok']), null);

        monteur = { platforms: ['instagram'], post_at: ['19:00'] };
        await approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' });
        assert.deepEqual(posts().map((p) => p.params[1]), ['instagram']);

        db.statements.length = 0;
        monteur = { platforms: ['tiktok'], post_at: ['19:00'] };
        directPostReady(true);
        await approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' });
        assert.deepEqual(posts().map((p) => p.params[1]), ['tiktok']);
        assert.equal(db.ran(/^INSERT INTO campaigns/).length, 0, 'a DM campaign answers Instagram and Facebook only');
    });

    it('creates the keyword campaign as POST /campaigns does: keyword and variants, the DM, every post', async () => {
        monteur = { platforms: ['instagram', 'facebook'], post_at: ['19:00'] };
        const outcome = await approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' });
        const [insert] = db.ran(/^INSERT INTO campaigns/);
        assert.deepEqual(insert!.params, [TENANT, 'دفتر, الدفتر', 'هلا {username} 👋', null, null, true, null]);
        assert.deepEqual(outcome.campaign, { id: 'campaign-1', trigger_keyword: 'دفتر, الدفتر', created: true });
    });

    it('reuses an active campaign that already answers the keyword, and makes none when keyword_create is off', async () => {
        monteur = { platforms: ['instagram', 'facebook'], post_at: ['19:00'] };
        campaigns = [{ id: 'old-1', trigger_keyword: 'دفت', is_active: true, post_id: null, match_mode: 'substring', created_at: new Date() }];
        const reused = await approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' });
        assert.deepEqual(reused.campaign, { id: 'old-1', trigger_keyword: 'دفت', created: false });
        assert.equal(db.ran(/^INSERT INTO campaigns/).length, 0);

        clip = { ...clip, copy: { ...COPY, keyword_create: false } };
        db.statements.length = 0;
        const none = await approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' });
        assert.equal(none.campaign, null);
        assert.equal(db.ran(/FROM campaigns/).length, 0);
    });

    it('409s unless the reel is in review, at the first read, before any other work', async () => {
        for (const status of ['rendering', 'scheduled', 'rejected', 'failed']) {
            clip = { ...clip, status };
            await assert.rejects(approveClip(TENANT, CLIP, {}), isStudioError(409), status);
        }
        assert.equal(posts().length, 0);
        assert.equal(db.ran(/FROM studio_settings|FOR UPDATE/).length, 0, 'no slot looked for, no transaction opened');
    });

    it('refuses, before writing, when TikTok is on but cannot Direct Post', async () => {
        await assert.rejects(approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' }), (err: unknown) =>
            err instanceof StudioError && err.status === 409 && /take TikTok off the Monteur's platforms/.test(err.message));
        assert.equal(posts().length, 0);
    });

    it('schedules once when two clicks race: the locked re-check finds it no longer in review', async () => {
        monteur = { platforms: ['instagram'], post_at: ['19:00'] };
        lockedStatus = 'scheduled';
        await assert.rejects(approveClip(TENANT, CLIP, { scheduled_time: '2026-10-01T16:00:00Z' }), isStudioError(409));
        assert.equal(posts().length, 0);
    });

    it('refuses a time it cannot read', async () => {
        await assert.rejects(approveClip(TENANT, CLIP, { scheduled_time: 'tomorrow' }), isStudioError(400));
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

    it('renders again for a new title, with the words on the clip’s clock and the same accent', async () => {
        db.routes.unshift([/payload->'brand'->>'accent' AS accent FROM studio_jobs WHERE creator_id = \$1 AND kind = 'monteur_render' AND payload->>'clipId'/, () => ({ rows: [{ accent: '#22C7F0' }] })]);
        await patchClip(TENANT, CLIP, { title: 'عنوان أقوى' });
        const [job] = renders();
        assert.equal(job!.params[1], 'monteur_render');
        const payload = JSON.parse(job!.params[2]);
        assert.equal(payload.title, 'عنوان أقوى');
        assert.equal(payload.brand.accent, '#22C7F0');
        assert.deepEqual(payload.words, [[0.15, 0.65, 'تبي'], [0.75, 1.15, 'دفتر']]);
        assert.deepEqual(payload.cta, { line1: 'اكتب في التعليقات «دفتر»', line2: 'ويوصلك الرابط بالخاص 📩' });
        assert.equal(payload.cover_at, 0.5);
        assert.ok(db.ran(/^UPDATE clip_drafts SET status = 'rendering'/).length === 1);
    });

    it('carries a new keyword into the caption’s ask, drops the old variants, and renders the new CTA', async () => {
        await patchClip(TENANT, CLIP, { copy: { keyword: 'ملاحظات' } });
        const saved = JSON.parse(db.ran(/^UPDATE clip_drafts SET title/)[0]!.params[3]);
        assert.ok(saved.caption.includes('اكتب "ملاحظات" بالتعليقات'), saved.caption);
        assert.ok(!saved.caption.includes('"دفتر"'));
        assert.deepEqual(saved.variants, []);
        assert.equal(saved.keyword_create, true);
        assert.match(JSON.parse(renders()[0]!.params[2]).cta.line1, /«ملاحظات»/);
    });

    it('refuses a caption that no longer asks for the keyword, writing nothing', async () => {
        await assert.rejects(patchClip(TENANT, CLIP, { copy: { caption: 'no ask here' } }), (err: unknown) =>
            err instanceof StudioError && err.status === 400 && /must keep the keyword ask/.test(err.message));
        await assert.rejects(patchClip(TENANT, CLIP, { copy: { tiktok_caption: 'no link line' } }), isStudioError(400));
        assert.equal(db.ran(/^UPDATE/).length, 0);
    });

    it('re-renders a failed clip whatever the edit', async () => {
        clip = { ...clip, status: 'failed' };
        await patchClip(TENANT, CLIP, { copy: { dm: 'هلا {username}' } });
        assert.equal(renders().length, 1);
    });

    it('refuses a scheduled or rejected clip, a field that is not one, and a bad value', async () => {
        clip = { ...clip, status: 'scheduled' };
        await assert.rejects(patchClip(TENANT, CLIP, { title: 'x' }), isStudioError(409));
        clip = { ...clip, status: 'rejected' };
        await assert.rejects(patchClip(TENANT, CLIP, { title: 'x' }), isStudioError(409));
        clip = { ...clip, status: 'review' };
        await assert.rejects(patchClip(TENANT, CLIP, { copy: { keyword: 'two words' } }), isStudioError(400));
        await assert.rejects(patchClip(TENANT, CLIP, { copy: { colour: 'red' } }), isStudioError(400));
        await assert.rejects(patchClip(TENANT, CLIP, { title: 'x'.repeat(61) }), isStudioError(400));
        await assert.rejects(patchClip(TENANT, CLIP, {}), isStudioError(400));
    });
});

describe('rejectClip', () => {
    it('stops its renders, rejects it, then deletes its files and may finish its source', async () => {
        await rejectClip(TENANT, CLIP);
        const order = db.statements.map((s) => s.sql);
        const cancel = order.findIndex((s) => /^UPDATE studio_jobs SET status = 'failed'.*kind = 'monteur_render' AND status = 'pending'/.test(s));
        const reject = order.findIndex((s) => /^UPDATE clip_drafts SET status = 'rejected'/.test(s));
        const del = order.findIndex((s) => /^DELETE FROM media_uploads/.test(s));
        assert.ok(cancel >= 0 && reject > cancel && del > reject, 'deleted only once the clip no longer names them');
        assert.deepEqual(db.statements[del]!.params, [TENANT, [VIDEO, COVER]]);
        assert.ok(order.some((s) => /^UPDATE monteur_sources s SET status = 'done'/.test(s)));
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
