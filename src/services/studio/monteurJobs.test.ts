/**
 * The Monteur's four job kinds in the Studio queue (MONTEUR.md §3): what each result does, and
 * what a failure marks failed. The pool answers by SQL, as in jobs.test.ts.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setLogSink } from '../../utils/log.js';
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import { StudioError } from './common.js';
import { completeJob, deleteUnreferencedUploads, failJob } from './jobs.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const JOB = '55555555-5555-4555-8555-555555555555';
const NEWER_JOB = '56565656-5656-4565-8565-565656565656';
const SOURCE = '66666666-6666-4666-8666-666666666666';
const CLIP = '77777777-7777-4777-8777-777777777777';
const VIDEO = 'a1111111-1111-4111-8111-111111111111';
const COVER = 'b1111111-1111-4111-8111-111111111111';
const OLD_VIDEO = 'c1111111-1111-4111-8111-111111111111';
const OLD_COVER = 'd1111111-1111-4111-8111-111111111111';
const up = (id: string) => `https://msg-response-auto.vercel.app/api/uploads/${id}`;
const KEY = (c: string) => c.repeat(40);

let db: FakeDb;
let restoreSink: (() => void) | undefined;

before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());
beforeEach(() => { db = installFakeDb(); });
afterEach(() => db.restore());

const isStudioError = (status: number) => (err: unknown) => err instanceof StudioError && err.status === status;

function lockReturns(job: Record<string, unknown>) {
    db.routes.push([/^SELECT id, creator_id, kind, status, payload FROM studio_jobs/, (p) => ({
        rows: p[0] === job.id && p[1] === TENANT ? [{ creator_id: TENANT, ...job }] : [],
    })]);
}
const storedResult = () => JSON.parse(db.ran(/SET status = 'done'/)[0]!.params[1]);
const writes = () => db.ran(/^(INSERT|UPDATE|DELETE)/);

// ─── pick_folder ────────────────────────────────────────────────────────────────────────

describe('completeJob — pick_folder', () => {
    beforeEach(() => {
        lockReturns({ id: JOB, kind: 'pick_folder', status: 'claimed', payload: { prompt: 'Choose' } });
        db.routes.push([/FROM studio_settings/, () => ({ rows: [] })]);
    });

    it('saves the chosen folder through the settings rules, in the same transaction', async () => {
        assert.equal(await completeJob(TENANT, JOB, { folder: '/Users/me/Movies/Monteur/\n' }), 'applied');
        const [write] = db.ran(/^INSERT INTO studio_settings/);
        assert.equal(write!.params[0], TENANT);
        assert.equal(JSON.parse(write!.params[8]).folder, '/Users/me/Movies/Monteur/', 'osascript’s newline is dropped');
        assert.deepEqual(storedResult(), { folder: '/Users/me/Movies/Monteur/' });
    });

    it('changes nothing when the dialog was cancelled', async () => {
        await completeJob(TENANT, JOB, { cancelled: true });
        assert.equal(db.ran(/studio_settings/).length, 0);
        assert.deepEqual(storedResult(), { cancelled: true });
    });

    it('refuses a folder the rules refuse, writing nothing, so the job stays claimed', async () => {
        await assert.rejects(completeJob(TENANT, JOB, { folder: 'Movies' }), isStudioError(400));
        assert.equal(writes().length, 0);
        await assert.rejects(completeJob(TENANT, JOB, { path: '/x' }), isStudioError(400));
    });
});

// ─── monteur_scan ───────────────────────────────────────────────────────────────────────

describe('completeJob — monteur_scan', () => {
    const file = (key: string, name: string) => ({ path: `/v/${name}`, name, key, size: 1234, mtime: 1, duration: 612.345 });
    let inserted: { id: string; path: string }[] = [];

    beforeEach(() => {
        inserted = [];
        lockReturns({ id: JOB, kind: 'monteur_scan', status: 'claimed', payload: { folder: '/v', limit: 2, known: [] } });
        db.routes.push(
            [/^INSERT INTO monteur_sources/, () => ({ rows: inserted })],
            [/FROM studio_settings/, () => ({ rows: [{ voice: { language: 'ar', digits: 'arabic-indic', guide: '' } }] })],
            [/^INSERT INTO studio_jobs/, (p) => ({ rows: [{ id: `job-${p[2]}`, kind: p[1] }] })],
        );
    });

    it('inserts the new files with ON CONFLICT DO NOTHING and queues one transcription per inserted row', async () => {
        inserted = [{ id: SOURCE, path: '/v/a.mp4' }];
        await completeJob(TENANT, JOB, {
            files: [file(KEY('a'), 'a.mp4'), file(KEY('b'), 'b.mov')],
            skipped: [{ name: 'short.mp4', reason: 'under 10 s' }],
            missing: false,
        });
        const [insert] = db.ran(/^INSERT INTO monteur_sources/);
        assert.match(insert!.sql, /ON CONFLICT \(creator_id, content_key\) DO NOTHING RETURNING id, path/);
        assert.equal(insert!.params[0], TENANT);
        assert.deepEqual(JSON.parse(insert!.params[1]).map((f: any) => [f.key, f.duration]), [[KEY('a'), 612.35], [KEY('b'), 612.35]]);

        // b was already known (the conflict returned nothing for it): no second transcript.
        const jobs = db.ran(/^INSERT INTO studio_jobs/);
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0]!.params[1], 'monteur_transcribe');
        assert.deepEqual(JSON.parse(jobs[0]!.params[2]), { sourceId: SOURCE, path: '/v/a.mp4', language: 'ar' });

        assert.deepEqual(storedResult(), {
            added: 1, skipped: 1, missing: false, skipped_files: [{ name: 'short.mp4', reason: 'under 10 s' }],
        });
    });

    it('takes at most `limit` files, each key once, and names an entry it cannot read', async () => {
        await completeJob(TENANT, JOB, {
            files: [file(KEY('a'), 'a.mp4'), file(KEY('a'), 'copy.mp4'), { path: 'relative.mp4', key: KEY('c') }, file(KEY('d'), 'd.mp4'), file(KEY('e'), 'e.mp4')],
            skipped: [], missing: false,
        });
        const sent = JSON.parse(db.ran(/^INSERT INTO monteur_sources/)[0]!.params[1]);
        assert.deepEqual(sent.map((f: any) => f.name), ['a.mp4', 'd.mp4']);
        assert.equal(storedResult().skipped, 1);
        assert.match(storedResult().skipped_files[0].reason, /unreadable: path must be an absolute path/);
    });

    it('records a missing folder, inserting nothing', async () => {
        await completeJob(TENANT, JOB, { files: [], skipped: [], missing: true });
        assert.equal(db.ran(/^INSERT INTO monteur_sources/).length, 0);
        assert.deepEqual(storedResult(), { added: 0, skipped: 0, missing: true, skipped_files: [] });
    });

    it('refuses a result that is not the contract’s shape', async () => {
        await assert.rejects(completeJob(TENANT, JOB, { lessons: [] }), isStudioError(400));
        assert.equal(writes().length, 0);
    });
});

// ─── monteur_transcribe ─────────────────────────────────────────────────────────────────

describe('completeJob — monteur_transcribe', () => {
    let status = 'transcribing';

    beforeEach(() => {
        status = 'transcribing';
        lockReturns({ id: JOB, kind: 'monteur_transcribe', status: 'claimed', payload: { sourceId: SOURCE, path: '/v/a.mp4', language: 'ar' } });
        db.routes.push([/^SELECT id, status FROM monteur_sources/, (p) => ({ rows: p[1] === TENANT ? [{ id: SOURCE, status }] : [] })]);
    });

    it('stores the words in time order and marks the source transcribed for the sweep', async () => {
        assert.equal(await completeJob(TENANT, JOB, {
            duration: 612.345,
            words: [[1.234, 1.5, 'ثانية'], [0.5, 0.9, 'أول'], [2, 1.99, 'crossed'], [3, 3.2, '   ']],
        }), 'applied');
        const [update] = db.ran(/^UPDATE monteur_sources SET words/);
        assert.match(update!.sql, /status = 'transcribed', attempts = 0, claimed_at = NULL, error = NULL/);
        assert.deepEqual(JSON.parse(update!.params[1]), [[0.5, 0.9, 'أول'], [1.23, 1.5, 'ثانية'], [2, 2, 'crossed']]);
        assert.equal(update!.params[2], 612.35);
    });

    it('drops a transcript for a source that is no longer waiting for one', async () => {
        status = 'failed';
        assert.equal(await completeJob(TENANT, JOB, { duration: 1, words: [[0, 1, 'x']] }), 'dropped');
        assert.equal(db.ran(/^UPDATE monteur_sources/).length, 0);
        assert.equal(storedResult().dropped, 'source_failed');
    });

    it('refuses the whole transcript when a word is not [t0, t1, text]', async () => {
        await assert.rejects(
            completeJob(TENANT, JOB, { words: [[0, 1, 'ok'], [2, 'x', 'bad'], 'word'] }),
            (err: unknown) => err instanceof StudioError && err.status === 400 && (err.problems ?? []).length === 2,
        );
        assert.equal(writes().length, 0);
    });

    it('refuses more than 40 000 words', async () => {
        const words = Array.from({ length: 40_001 }, (_, i) => [i, i + 0.5, 'w']);
        await assert.rejects(completeJob(TENANT, JOB, { words }), isStudioError(400));
    });
});

// ─── monteur_render ─────────────────────────────────────────────────────────────────────

describe('completeJob — monteur_render', () => {
    let clipStatus = 'rendering';
    let latest = JOB;
    let media: Record<string, string> = {};
    const result = { video_url: up(VIDEO), cover_url: up(COVER), duration: 31.257, width: 1080, height: 1920 };

    beforeEach(() => {
        clipStatus = 'rendering';
        latest = JOB;
        media = { [VIDEO]: 'video/mp4', [COVER]: 'image/jpeg' };
        lockReturns({ id: JOB, kind: 'monteur_render', status: 'claimed', payload: { clipId: CLIP, sourceId: SOURCE } });
        db.routes.push(
            [/^SELECT id, mime_type FROM media_uploads/, (p) => ({
                rows: p[1] === TENANT ? (p[0] as string[]).filter((id) => media[id]).map((id) => ({ id, mime_type: media[id] })) : [],
            })],
            [/^SELECT id, source_id, status, render FROM clip_drafts/, () => ({
                rows: [{ id: CLIP, source_id: SOURCE, status: clipStatus, render: { video_url: up(OLD_VIDEO), cover_url: up(OLD_COVER), duration: 30, job_id: 'old', rendered_at: 'x' } }],
            })],
            [/kind = 'monteur_render' AND payload->>'clipId' = \$2 ORDER BY created_at DESC, id DESC/, () => ({ rows: [{ id: latest }] })],
            [/^DELETE FROM media_uploads/, (p) => ({ rows: [], rowCount: p[1].length })],
        );
    });

    it('puts the clip in review with its render, deletes the previous render, and may finish the source', async () => {
        assert.equal(await completeJob(TENANT, JOB, result), 'applied');
        const [land] = db.ran(/^UPDATE clip_drafts SET render/);
        assert.match(land!.sql, /status = 'review', error = NULL/);
        const render = JSON.parse(land!.params[1]);
        assert.deepEqual({ ...render, rendered_at: 'x' }, {
            video_url: up(VIDEO), cover_url: up(COVER), duration: 31.26, job_id: JOB, rendered_at: 'x',
        });
        const [del] = db.ran(/^DELETE FROM media_uploads/);
        assert.deepEqual(del!.params, [TENANT, [OLD_VIDEO, OLD_COVER]]);
        const [done] = db.ran(/^UPDATE monteur_sources s SET status = 'done'/);
        assert.deepEqual(done!.params, [SOURCE, TENANT]);
        assert.match(done!.sql, /s\.status = 'rendering' AND NOT EXISTS \(SELECT 1 FROM clip_drafts c WHERE c\.source_id = s\.id AND c\.status = 'rendering'\)/);
        // The landing comes before the delete: until then the clip still names the old files.
        const order = db.statements.map((s) => s.sql);
        assert.ok(order.findIndex((s) => /^UPDATE clip_drafts SET render/.test(s)) < order.findIndex((s) => /^DELETE FROM media_uploads/.test(s)));
    });

    it('drops a render an edit superseded, and deletes its files', async () => {
        latest = NEWER_JOB;
        assert.equal(await completeJob(TENANT, JOB, result), 'dropped');
        assert.equal(db.ran(/^UPDATE clip_drafts/).length, 0);
        assert.deepEqual(db.ran(/^DELETE FROM media_uploads/)[0]!.params, [TENANT, [VIDEO, COVER]]);
        assert.equal(storedResult().dropped, 'superseded');
    });

    it('drops a render for a clip rejected meanwhile', async () => {
        clipStatus = 'rejected';
        assert.equal(await completeJob(TENANT, JOB, result), 'dropped');
        assert.equal(storedResult().dropped, 'clip_rejected');
    });

    it('accepts only this tenant’s uploads, of the right kinds', async () => {
        media = { [VIDEO]: 'video/mp4' };
        await assert.rejects(completeJob(TENANT, JOB, result), (err: unknown) =>
            err instanceof StudioError && err.status === 400 && (err.problems ?? []).some((p) => p.includes(`upload ${COVER} does not exist`)));
        media = { [VIDEO]: 'image/jpeg', [COVER]: 'image/jpeg' };
        await assert.rejects(completeJob(TENANT, JOB, result), (err: unknown) =>
            err instanceof StudioError && (err.problems ?? []).some((p) => /video_url: .* is image\/jpeg, not video\/mp4/.test(p)));
        await assert.rejects(completeJob(TENANT, JOB, { ...result, cover_url: 'https://elsewhere.example/c.jpg' }), isStudioError(400));
        assert.equal(db.ran(/^UPDATE clip_drafts|^DELETE/).length, 0);
    });
});

// ─── Fail ───────────────────────────────────────────────────────────────────────────────

describe('failJob — what a Monteur failure marks failed', () => {
    it('a transcription fails its source', async () => {
        lockReturns({ id: JOB, kind: 'monteur_transcribe', status: 'claimed', payload: { sourceId: SOURCE } });
        await failJob(TENANT, JOB, 'whisper crashed');
        const [source] = db.ran(/^UPDATE monteur_sources SET status = 'failed'/);
        assert.deepEqual(source!.params, [SOURCE, TENANT, 'whisper crashed']);
        assert.match(source!.sql, /status = 'transcribing'/);
    });

    it('a render fails its clip when it is the latest, and the last clip to finish finishes its source', async () => {
        lockReturns({ id: JOB, kind: 'monteur_render', status: 'claimed', payload: { clipId: CLIP } });
        db.routes.push(
            [/payload->>'clipId' = \$2 ORDER BY created_at DESC, id DESC/, () => ({ rows: [{ id: JOB }] })],
            [/^UPDATE clip_drafts SET status = 'failed'/, () => ({ rows: [{ source_id: SOURCE }] })],
        );
        await failJob(TENANT, JOB, 'ffmpeg exited 1');
        const [clip] = db.ran(/^UPDATE clip_drafts SET status = 'failed'/);
        assert.deepEqual(clip!.params, [CLIP, TENANT, 'ffmpeg exited 1']);
        assert.match(clip!.sql, /status = 'rendering'/);
        assert.deepEqual(db.ran(/^UPDATE monteur_sources s SET status = 'done'/)[0]!.params, [SOURCE, TENANT]);
    });

    it('leaves the clip alone when a newer render is on its way', async () => {
        lockReturns({ id: JOB, kind: 'monteur_render', status: 'claimed', payload: { clipId: CLIP } });
        db.routes.push([/payload->>'clipId' = \$2 ORDER BY created_at DESC, id DESC/, () => ({ rows: [{ id: NEWER_JOB }] })]);
        await failJob(TENANT, JOB, 'late');
        assert.equal(db.ran(/^UPDATE (clip_drafts|monteur_sources)/).length, 0);
    });

    it('a failed folder pick or scan is only a failed job', async () => {
        for (const kind of ['pick_folder', 'monteur_scan']) {
            db.statements.length = 0;
            db.routes.length = 0;
            lockReturns({ id: JOB, kind, status: 'claimed', payload: {} });
            await failJob(TENANT, JOB, 'no');
            assert.equal(writes().length, 1, kind);
            assert.match(writes()[0]!.sql, /^UPDATE studio_jobs SET status = 'failed'/, kind);
        }
    });

    it('404s another tenant’s job', async () => {
        lockReturns({ id: JOB, kind: 'monteur_render', status: 'claimed', payload: { clipId: CLIP } });
        await assert.rejects(failJob(OTHER, JOB, 'x'), isStudioError(404));
    });
});

describe('deleteUnreferencedUploads — a live reel’s files are in use', () => {
    it('keeps what a clip rendering, in review or scheduled shows, as well as what a post names', async () => {
        await deleteUnreferencedUploads(pool, TENANT, [up(VIDEO)]);
        const [del] = db.ran(/^DELETE FROM media_uploads/);
        assert.match(del!.sql, /NOT EXISTS \( SELECT 1 FROM scheduled_posts s/);
        assert.match(del!.sql, /AND NOT EXISTS \( SELECT 1 FROM clip_drafts c WHERE c\.status IN \('rendering', 'review', 'scheduled'\) AND \(COALESCE\(c\.render->>'video_url', ''\) \|\| ' ' \|\| COALESCE\(c\.render->>'cover_url', ''\)\) LIKE '%' \|\| m\.id::text \|\| '%'/);
    });
});
