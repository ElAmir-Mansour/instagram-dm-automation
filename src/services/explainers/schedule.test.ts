/**
 * Schedule (schedule.ts): a ready explainer becomes posts through `insertVideoPost`, in one group. The rows are the ones the composer and the Monteur write, so
 * what is checked is the choice of file, cover, caption and options per platform, the credit line, the time, and what stops a schedule.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { ExplainerRow } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { StudioError } from '../studio/common.js';
import { defaultInfographicConfig, type ExplainerTrack } from '../studio/settingsTypes.js';
import { ExplainerError } from './errors.js';
import { parseWhen, scheduleExplainer, withCredit, YOUTUBE_SHORT_MAX_SECONDS } from './schedule.js';
import { EXPLAINER, TENANT, validWriterOutput } from './testFixtures.js';
import { BASE, explainerSettings, installWorld, type World } from './testDb.js';

const id = (n: number) => `${String(n).padStart(2, '0').repeat(4)}-1111-4111-8111-111111111111`;
const up = (n: number) => `${BASE}/api/uploads/${id(n)}`;
const NOW = Date.parse('2026-10-25T09:00:00Z');
const TRACK: ExplainerTrack = { key: 'calm-01', title: 'Calm', artist: 'A. Composer', media_id: id(9), url: `/api/uploads/${id(9)}`, license: 'CC BY 4.0', credit: 'Music: "Calm" by A. Composer (CC BY 4.0)', credit_required: true };
const FREE_TRACK: ExplainerTrack = { ...TRACK, key: 'free-01', credit: '', credit_required: false };

let world: World;
let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

function setup(opts: { platforms?: string[]; music?: ExplainerTrack[]; tz?: string } = {}) {
    world = installWorld();
    world.settingsRow = {
        ...explainerSettings({ music: opts.music ?? [TRACK, FREE_TRACK] }),
        infographic: { ...defaultInfographicConfig(), platforms: opts.platforms ?? ['instagram', 'facebook', 'youtube'] },
        schedule: { timezone: opts.tz ?? 'UTC', slots: ['12:00'] },
        monteur: { post_at: ['16:00'] },
    };
}
beforeEach(() => setup());
afterEach(() => world.restore());

const OUT = validWriterOutput(12);
const render = (over = {}) => ({ vertical_url: up(2), horizontal_url: up(3), cover_url: up(4), duration: 72.4, sound_mode: 'sfx' as const, version: 1, job_id: 'j', ...over });
function ready(over: Partial<ExplainerRow> = {}) {
    return world.addExplainer({
        status: 'ready', title: OUT.title, draft_version: 1, render: render(), language: 'ar',
        draft: { writer: 'claude_mac', captions: { meta: 'META caption', youtube: { title: 'YT title', description: 'YT description' }, tiktok: 'TT caption' }, first_comment: 'c', replies: [], sources: OUT.sources, est_seconds: 72, warnings: [] },
        ...over,
    });
}
const posts = () => world.posts;
const byPlatform = (platform: string) => world.posts.find((p) => p.platform === platform)!;
const refused = (code: string) => (err: unknown): boolean => err instanceof ExplainerError && err.code === code && err.status === 409;

describe('scheduleExplainer: what is posted where', () => {
    it('Instagram and Facebook get the vertical video with its cover and the meta caption; YouTube a Short (the vertical video, with the cover) up to three minutes; TikTok an inbox draft', async () => {
        ready();
        const out = await scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW);
        assert.deepEqual(posts().map((p) => p.platform), ['both', 'youtube', 'tiktok']);
        const both = byPlatform('both');
        assert.deepEqual([both.media_url, both.cover_url, both.caption, both.post_type, both.status, both.platform_options], [up(2), up(4), 'META caption', 'video', 'PENDING', null]);
        const youtube = byPlatform('youtube');
        assert.deepEqual([youtube.media_url, youtube.cover_url, youtube.caption], [up(2), up(4), 'YT description'], '72 s: a Short, the vertical video');
        assert.deepEqual(youtube.platform_options, { title: 'YT title', language: 'ar' });
        const tiktok = byPlatform('tiktok');
        assert.deepEqual([tiktok.media_url, tiktok.cover_url, tiktok.caption, tiktok.platform_options], [up(2), null, 'TT caption', { mode: 'inbox' }], 'TikTok picks its own cover; an inbox draft, never a direct post');
        assert.equal(out.rows.length, 3);
    });

    it('YouTube gets the HORIZONTAL video when the render is longer than three minutes, with no thumbnail of ours: the cover is a vertical frame', async () => {
        ready({ render: render({ duration: YOUTUBE_SHORT_MAX_SECONDS + 0.1 }) });
        await scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW);
        const youtube = byPlatform('youtube');
        assert.deepEqual([youtube.media_url, youtube.cover_url], [up(3), null]);
        assert.deepEqual(youtube.platform_options, { title: 'YT title', language: 'ar', shorts: false }, 'not a Short: YouTube publishing adds no #Shorts to it');
        assert.equal(byPlatform('both').media_url, up(2), 'Instagram and Facebook keep the vertical one');
        assert.equal(byPlatform('tiktok').media_url, up(2));
    });

    it('exactly three minutes is still a Short, and a Short’s row is tagged as every YouTube row is: it carries no `shorts` option', async () => {
        ready({ render: render({ duration: 180 }) });
        await scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW);
        assert.equal(byPlatform('youtube').media_url, up(2));
        assert.deepEqual(byPlatform('youtube').platform_options, { title: 'YT title', language: 'ar' });
        assert.ok(!('shorts' in byPlatform('youtube').platform_options));
    });

    it('only the YouTube row of a long video opts out: Instagram, Facebook and TikTok rows are written exactly as they were', async () => {
        ready({ render: render({ duration: 600 }) });
        await scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW);
        assert.equal(byPlatform('both').platform_options, null);
        assert.deepEqual(byPlatform('tiktok').platform_options, { mode: 'inbox' });
        assert.deepEqual(byPlatform('youtube').platform_options.shorts, false);
    });

    it('the opt-out is by the video, not the explainer: a long one and a short one, scheduled the same way, differ only in that row', async () => {
        ready({ render: render({ duration: 72 }) });
        await scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW);
        const short = structuredClone(byPlatform('youtube').platform_options);
        world.posts.length = 0;
        world.explainer().status = 'ready';
        world.explainer().schedule = null;
        world.explainer().render = render({ duration: 301 });
        await scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW);
        assert.deepEqual(byPlatform('youtube').platform_options, { ...short, shorts: false });
    });

    it('every row is in one group, and the explainer records the group, the time and the rows', async () => {
        ready();
        const out = await scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW);
        const groups = new Set(posts().map((p) => p.group_id));
        assert.equal(groups.size, 1);
        assert.match([...groups][0], /^[0-9a-f-]{36}$/);
        const row = world.explainer();
        assert.equal(row.status, 'scheduled');
        assert.deepEqual(row.schedule, { scheduled_time: '2026-10-25T09:00:00.000Z', group_id: [...groups][0], row_ids: posts().map((p) => p.id) });
        assert.equal(out.explainer.status, 'scheduled');
        assert.equal(out.scheduled_time, '2026-10-25T09:00:00.000Z');
    });

    it('follows the brand’s platforms for Instagram, Facebook and YouTube, and always makes the TikTok inbox draft', async () => {
        setup({ platforms: ['facebook'] });
        ready();
        await scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW);
        assert.deepEqual(posts().map((p) => p.platform), ['facebook', 'tiktok']);
        world.restore();
        setup({ platforms: ['youtube'] });
        ready();
        await scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW);
        assert.deepEqual(posts().map((p) => p.platform), ['youtube', 'tiktok']);
        world.restore();
        setup({ platforms: [] });
        ready();
        await scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW);
        assert.deepEqual(posts().map((p) => p.platform), ['tiktok']);
    });

    it('falls back to the video’s title when YouTube’s caption has none', async () => {
        ready({ draft: { ...ready().draft!, captions: { meta: 'm', youtube: { title: '  ', description: 'd' }, tiktok: 't' } } });
        await scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW);
        assert.equal(byPlatform('youtube').platform_options.title, OUT.title);
    });
});

describe('scheduleExplainer: the music credit', () => {
    it('is appended to every caption when the track requires credit, and to none when it does not', async () => {
        ready({ sound_mode: 'music', music_track_id: 'calm-01', render: render({ sound_mode: 'music' }) });
        await scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW);
        for (const [platform, text] of [['both', 'META caption'], ['youtube', 'YT description'], ['tiktok', 'TT caption']] as const) {
            assert.equal(byPlatform(platform).caption, `${text}\n\n${TRACK.credit}`, platform);
        }
        world.restore();
        setup();
        ready({ sound_mode: 'music', music_track_id: 'free-01', render: render({ sound_mode: 'music' }) });
        await scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW);
        assert.equal(byPlatform('both').caption, 'META caption');
    });

    it('is not added to a video made with sound effects only', async () => {
        ready({ sound_mode: 'sfx', music_track_id: 'calm-01' });
        await scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW);
        assert.equal(byPlatform('both').caption, 'META caption');
    });

    it('is refused when the sound is music and the track is gone: its credit line cannot be written, and nothing is posted', async () => {
        ready({ sound_mode: 'music', music_track_id: 'deleted', render: render({ sound_mode: 'music' }) });
        await assert.rejects(scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW), refused('EXPLAINER_NO_TRACK'));
        assert.equal(posts().length, 0);
        assert.equal(world.explainer().status, 'ready');
    });

    it('cuts a caption’s body to make room for the credit, never the credit, and says so', async () => {
        const long = 'x '.repeat(1100);
        ready({ sound_mode: 'music', music_track_id: 'calm-01', render: render({ sound_mode: 'music' }), draft: { ...ready().draft!, captions: { meta: long, youtube: { title: 't', description: 'd' }, tiktok: 't' } } });
        const out = await scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW);
        const caption = byPlatform('both').caption as string;
        assert.ok([...caption].length <= 2200, String([...caption].length));
        assert.ok(caption.endsWith(`…\n\n${TRACK.credit}`));
        assert.deepEqual(out.trimmed, ['meta']);
    });
});

describe('withCredit', () => {
    it('is the caption alone when there is no credit, and the caption and the credit after a blank line when there is', () => {
        assert.deepEqual(withCredit('  a caption  ', null, 100), { text: 'a caption', trimmed: false });
        assert.deepEqual(withCredit('a caption', '   ', 100), { text: 'a caption', trimmed: false });
        assert.deepEqual(withCredit('a caption', 'Music: x', 100), { text: 'a caption\n\nMusic: x', trimmed: false });
        assert.deepEqual(withCredit('', 'Music: x', 100), { text: 'Music: x', trimmed: false });
    });

    it('cuts the body at a word to make the two fit, ends it with an ellipsis, and keeps the credit whole', () => {
        const made = withCredit('one two three four five six seven eight', 'Music: x', 30);
        assert.equal(made.trimmed, true);
        assert.ok([...made.text].length <= 30, made.text);
        assert.ok(made.text.endsWith('…\n\nMusic: x'));
        assert.doesNotMatch(made.text, /seve…/, 'not in the middle of a word');
    });

    it('a credit that fills the limit by itself is the whole caption, cut to the limit', () => {
        const made = withCredit('body', 'y'.repeat(50), 20);
        assert.equal(made.text, 'y'.repeat(20));
        assert.equal(made.trimmed, true);
    });

    it('counts characters as the platforms do: an emoji is one', () => {
        assert.equal(withCredit('😀'.repeat(5), '🎵', 20).trimmed, false);
    });
});

describe('scheduleExplainer: when', () => {
    it('now is now', async () => {
        ready();
        const out = await scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW);
        assert.equal(out.scheduled_time, '2026-10-25T09:00:00.000Z');
        assert.ok(posts().every((p) => +new Date(p.scheduled_time) === NOW));
    });

    it('next, which is the default, is the next free posting slot: the Monteur’s post_at, in the tenant’s zone, as infographics take it', async () => {
        setup({ tz: 'Asia/Kuwait' });
        ready();
        const out = await scheduleExplainer(TENANT, EXPLAINER, {}, NOW);
        assert.equal(out.scheduled_time, '2026-10-25T13:00:00.000Z', 'it is 12:00 in Kuwait now, so 16:00 there, today, is the next slot');
    });

    it('a time the owner names is that time, in any form a date takes', async () => {
        ready();
        const out = await scheduleExplainer(TENANT, EXPLAINER, { when: '2026-11-01T16:30:00+03:00' }, NOW);
        assert.equal(out.scheduled_time, '2026-11-01T13:30:00.000Z');
    });

    it('a time that is not one is a 400 INVALID_SCHEDULE_TIME, before anything is read or written', async () => {
        ready();
        for (const when of ['tomorrow-ish', 'NOW', '', 5, {}, []]) {
            await assert.rejects(scheduleExplainer(TENANT, EXPLAINER, { when }, NOW), (err: unknown) => err instanceof StudioError && err.status === 400 && err.code === 'INVALID_SCHEDULE_TIME', String(when));
        }
        assert.equal(posts().length, 0);
        assert.deepEqual(parseWhen(undefined), { kind: 'next' });
        assert.deepEqual(parseWhen(null), { kind: 'next' });
        assert.deepEqual(parseWhen('next'), { kind: 'next' });
        assert.deepEqual(parseWhen('now'), { kind: 'now' });
    });

    it('says NO_FREE_SLOT when the posting times are all taken for weeks, and posts nothing', async () => {
        world.settingsRow = { ...world.settingsRow!, monteur: { post_at: [] } };
        ready();
        await assert.rejects(scheduleExplainer(TENANT, EXPLAINER, { when: 'next' }, NOW), (err: unknown) => err instanceof StudioError && err.status === 409 && err.code === 'NO_FREE_SLOT');
        assert.equal(posts().length, 0);
        assert.equal(world.explainer().status, 'ready');
    });
});

describe('scheduleExplainer: what stops it', () => {
    it('is only for a ready explainer, and an explainer already scheduled is not scheduled twice', async () => {
        ready({ status: 'review', render: null });
        await assert.rejects(scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW), refused('EXPLAINER_BAD_STATE'));
        world.explainers.clear();
        ready({ status: 'scheduled' });
        await assert.rejects(scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW), refused('EXPLAINER_BAD_STATE'));
        world.explainers.clear();
        ready({ render: null });
        await assert.rejects(scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW), refused('EXPLAINER_BAD_STATE'));
        assert.equal(posts().length, 0);
    });

    it('is refused when the video is older than the edits: the narration moved on, or the sound was changed after the render', async () => {
        ready({ draft_version: 2 });
        await assert.rejects(scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW), refused('EXPLAINER_RENDER_STALE'));
        world.explainers.clear();
        ready({ sound_mode: 'music', music_track_id: 'calm-01', render: render({ sound_mode: 'sfx' }) });
        await assert.rejects(scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW), refused('EXPLAINER_RENDER_STALE'));
        assert.equal(posts().length, 0);
    });

    it('is a 404 for another tenant’s explainer and for a malformed id', async () => {
        ready();
        await assert.rejects(scheduleExplainer('77777777-7777-4777-8777-777777777777', EXPLAINER, { when: 'now' }, NOW), (err: unknown) => err instanceof ExplainerError && err.code === 'EXPLAINER_NOT_FOUND');
        await assert.rejects(scheduleExplainer(TENANT, 'nope', { when: 'now' }, NOW), (err: unknown) => err instanceof ExplainerError && err.code === 'EXPLAINER_NOT_FOUND');
    });

    it('takes the tenant’s publishing lock before it chooses a slot, and writes the rows and the move in one transaction: a failed move posts nothing', async () => {
        ready();
        world.db.routes.unshift([/^UPDATE explainers SET status = \$2/, () => { throw new Error('connection terminated'); }]);
        await assert.rejects(scheduleExplainer(TENANT, EXPLAINER, { when: 'now' }, NOW), /connection terminated/);
        assert.equal(world.posts.length, 0, 'the rows written before the move failed are rolled back with it');
        const sql = world.db.statements.map((s) => s.sql);
        assert.ok(sql.findIndex((s) => /pg_advisory_xact_lock/.test(s)) < sql.findIndex((s) => /^INSERT INTO scheduled_posts/.test(s)));
        assert.equal(world.explainer().status, 'ready');
    });
});
