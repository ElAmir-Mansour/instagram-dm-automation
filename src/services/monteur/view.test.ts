/**
 * What the Monteur page reads (MONTEUR.md §5): the view's parts that are more than a SELECT —
 * the last scan's error, the lessons in use beside the last run, how a TikTok post would go out,
 * whose rows hold a slot, and scheduled reels whose posts are gone.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { StudioError } from '../studio/common.js';
import { ELAMIR_SETTINGS } from '../studio/testFixtures.js';
import { installFakeDb, type FakeDb } from './testDb.js';
import { getMonteurView, retrySource } from './view.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '66666666-6666-4666-8666-666666666666';
const NOW = Date.parse('2026-09-27T09:00:00Z');

let db: FakeDb;
let monteur: Record<string, unknown>;
let appSettings: Record<string, string>;
let scan: Record<string, unknown> | null;
let lessons: Record<string, unknown>[];
let clips: Record<string, unknown>[];

beforeEach(() => {
    db = installFakeDb();
    monteur = { enabled: true, folder: '/v', platforms: ['instagram', 'tiktok'], post_at: ['19:00'] };
    appSettings = {};
    scan = null;
    lessons = [];
    clips = [];
    db.routes.push(
        [/FROM studio_settings/, () => ({ rows: [{ ...ELAMIR_SETTINGS, monteur: { ...ELAMIR_SETTINGS.monteur, ...monteur } }] })],
        [/FROM app_settings/, (p) => ({ rows: appSettings[p[0]] === undefined ? [] : [{ value: appSettings[p[0]], is_secret: false }] })],
        [/^UPDATE clip_drafts c SET status = 'review', schedule = NULL/, () => ({ rows: [], rowCount: 1 })],
        [/^SELECT updated_at, status, result, error FROM studio_jobs/, () => ({ rows: scan ? [scan] : [] })],
        [/FROM studio_lessons/, () => ({ rows: lessons })],
        [/FROM clip_drafts c JOIN monteur_sources s/, () => ({ rows: clips })],
    );
});
afterEach(() => db.restore());

const clipRow = (fields: Record<string, unknown> = {}) => ({
    id: 'c1', source_id: SOURCE, source_name: 'a.mp4', rank: 1, status: 'review', start_s: 1, end_s: 31, title: 't', hook: 'h',
    why: null, score: 8, topic: 'x', hook_type: 'problem', scores: { hook: 3, alone: 2, payoff: 2, send: 2 }, copy: {},
    render: { video_url: 'v', tiktok_video_url: 'tv', cover_url: 'c', duration: 30, job_id: 'j', rendered_at: 'r' },
    schedule: null, error: null, created_at: new Date(NOW), ...fields,
});

describe('getMonteurView', () => {
    it('frees a scheduled reel whose posts are gone before listing anything', async () => {
        await getMonteurView(TENANT, NOW);
        const [release] = db.statements;
        assert.match(release!.sql, /^SELECT brand/, 'the settings first');
        const releaseAt = db.statements.findIndex((s) => /SET status = 'review', schedule = NULL/.test(s.sql));
        const listAt = db.statements.findIndex((s) => /FROM clip_drafts c JOIN monteur_sources s/.test(s.sql));
        assert.ok(releaseAt >= 0 && releaseAt < listAt);
        assert.deepEqual(db.statements[releaseAt]!.params, [TENANT, null]);
    });

    it('reports the last scan to finish, with a failed one’s message', async () => {
        scan = { updated_at: new Date(NOW), status: 'failed', result: null, error: 'The folder is outside the allowed roots.' };
        const view = await getMonteurView(TENANT, NOW);
        assert.deepEqual(view.last_scan, { at: new Date(NOW).toISOString(), added: 0, skipped: 0, missing: false, error: 'The folder is outside the allowed roots.' });
        scan = { updated_at: new Date(NOW), status: 'done', result: { added: 2, skipped: 1, missing: false }, error: null };
        assert.deepEqual((await getMonteurView(TENANT, NOW)).last_scan?.error, null);
    });

    it('says a TikTok post goes out private until TikTok audits the app, and public after', async () => {
        clips = [clipRow()];
        let view = await getMonteurView(TENANT, NOW);
        assert.equal(view.tiktok_privacy, 'SELF_ONLY');
        assert.equal(view.clips[0]!.tiktok_privacy, 'SELF_ONLY');
        assert.equal(view.clips[0]!.tiktok_video_url, 'tv');
        assert.deepEqual([view.clips[0]!.topic, view.clips[0]!.hook_type], ['x', 'problem']);
        appSettings['tiktok.audited'] = 'true';
        view = await getMonteurView(TENANT, NOW);
        assert.equal(view.tiktok_privacy, 'PUBLIC_TO_EVERYONE');
        monteur = { ...monteur, platforms: ['instagram'] };
        assert.equal((await getMonteurView(TENANT, NOW)).tiktok_privacy, null);
    });

    it('has a next run in course mode with no folder, and none in folder mode without one', async () => {
        monteur = { ...monteur, source: 'course', folder: null };
        assert.equal((await getMonteurView(TENANT, NOW)).next_run, '2026-09-28T04:00:00.000Z', '07:00 Riyadh tomorrow');
        monteur = { ...monteur, source: 'folder', folder: null };
        assert.equal((await getMonteurView(TENANT, NOW)).next_run, null);
    });

    it('lists each clip’s edits (MONTEUR.md §6.2), and [] for a clip that has none', async () => {
        const edits = [{ t: 4.2, kind: 'tool', text: 'NotebookLM', sfx: 'whoosh' }, { t: 9, kind: 'punch' }];
        clips = [clipRow({ edits }), clipRow({ id: 'c2', edits: null })];
        const view = await getMonteurView(TENANT, NOW);
        assert.match(db.ran(/FROM clip_drafts c JOIN monteur_sources s/)[0]!.sql, /\bc\.edits\b/);
        assert.deepEqual(view.clips[0]!.edits, edits);
        assert.deepEqual(view.clips[1]!.edits, []);
    });

    it('reports a scheduled reel’s privacy as it went out', async () => {
        appSettings['tiktok.audited'] = 'true';
        clips = [clipRow({ status: 'scheduled', schedule: { scheduled_time: 'x', tiktok_privacy: 'SELF_ONLY' } })];
        assert.equal((await getMonteurView(TENANT, NOW)).clips[0]!.tiktok_privacy, 'SELF_ONLY');
    });

    it('finds next_slot with the one slot rule every caller uses, whatever the platforms', async () => {
        for (const platforms of [['tiktok'], ['facebook', 'tiktok']]) {
            monteur = { ...monteur, platforms };
            db.statements.length = 0;
            await getMonteurView(TENANT, NOW);
            const [slots] = db.ran(/^SELECT p\.scheduled_time FROM scheduled_posts p/);
            assert.match(slots!.sql, /p\.platform = 'tiktok' AND \(p\.group_id IS NULL OR NOT EXISTS/);
            assert.equal(slots!.params.length, 3, 'no per-caller list of platforms');
        }
    });

    it('shows the lessons in use, and beside them the latest run — a failed refresh included', async () => {
        const done = { id: 'l1', creator_id: TENANT, status: 'done', lessons: [{ rule: 'r', evidence: 'e' }], summary: 's', basis: { posts: 5, from: 'a', to: 'b' }, model: 'm', error: null, created_at: new Date(NOW - 86_400_000) };
        const failed = { id: 'l2', creator_id: TENANT, status: 'failed', lessons: null, summary: null, basis: null, model: null, error: 'HTTP 429', created_at: new Date(NOW - 60_000) };
        lessons = [done, failed];
        const view = await getMonteurView(TENANT, NOW);
        assert.equal(view.lessons?.status, 'done');
        assert.deepEqual(view.lessons?.lessons, [{ rule: 'r', evidence: 'e' }]);
        assert.deepEqual(view.lessons?.last_run, { status: 'failed', error: 'HTTP 429', created_at: new Date(NOW - 60_000).toISOString() });
        lessons = [failed];
        const first = await getMonteurView(TENANT, NOW);
        assert.equal(first.lessons?.status, 'failed', 'before any run has finished, the latest attempt shows');
    });
});

describe('retrySource', () => {
    it('sends a source with words back to transcribed, its attempts reset and its saved pick cleared', async () => {
        db.routes.unshift([/^SELECT id, status, path, words IS NOT NULL AS has_words/, () => ({ rows: [{ id: SOURCE, status: 'no_clips', path: '/v/a.mp4', has_words: true }] })]);
        db.routes.unshift([/FROM monteur_sources s WHERE s\.id = \$1/, () => ({ rows: [{ id: SOURCE, name: 'a', path: '/v/a.mp4', duration: 1, status: 'transcribed', error: null, clips: 0, created_at: new Date(), updated_at: new Date() }] })]);
        const view = await retrySource(TENANT, SOURCE);
        assert.equal(view.status, 'transcribed');
        const [update] = db.ran(/^UPDATE monteur_sources SET status = 'transcribed'/);
        assert.match(update!.sql, /attempts = 0, claimed_at = NULL, error = NULL, pick = NULL/);
    });

    it('409s a source that is neither failed nor without clips', async () => {
        db.routes.unshift([/^SELECT id, status, path, words IS NOT NULL AS has_words/, () => ({ rows: [{ id: SOURCE, status: 'rendering', path: '/v', has_words: true }] })]);
        await assert.rejects(retrySource(TENANT, SOURCE), (err: unknown) => err instanceof StudioError && err.status === 409);
    });
});
