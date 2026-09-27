/**
 * The daily run (MONTEUR.md §7): which `run_at` instant is due, in the tenant's timezone, and when
 * a claim queues the scan. The jobs table is a list the fake pool answers from, so "a scan exists
 * after 07:00" is observed rather than asserted about SQL.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { StudioError } from '../studio/common.js';
import {
    COURSE_LOOKAHEAD, enqueueDueMonteurScan, latestRunAt, nextRunAt, requestFolderPick, runMonteurNow, SCAN_EXTENSIONS, SCAN_MIN_AGE_S,
} from './daily.js';
import { installFakeDb, type FakeDb } from './testDb.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const at = (iso: string) => Date.parse(iso);

/** The Studio library as stored: in no particular order, one lesson already a Monteur source. */
const LESSONS = [
    { video_path: '/c/10.1.mp4', lesson_no: '10.1', title: 'Ten one' },
    { video_path: '/c/G.1.mp4', lesson_no: 'G.1', title: 'Gemini' },
    { video_path: '/c/1.10.mp4', lesson_no: '1.10', title: 'One ten' },
    { video_path: '/c/1.2.mp4', lesson_no: '1.2', title: 'One two' },
    { video_path: '/c/1.1.mp4', lesson_no: '1.1', title: 'One one' },
];
/** The fake's NOT EXISTS: lessons whose path is already a source. */
let sourcePaths: string[];
const courseRoute: [RegExp, (p: unknown[]) => { rows: unknown[] }] = [
    /^SELECT l\.video_path, l\.lesson_no, l\.title FROM course_lessons l/,
    () => ({ rows: LESSONS.filter((l) => !sourcePaths.includes(l.video_path)) }),
];
const iso = (ms: number) => new Date(ms).toISOString();

describe('latestRunAt / nextRunAt', () => {
    it('reads run_at in the tenant’s timezone: 07:00 in Riyadh is 04:00Z', () => {
        assert.equal(iso(latestRunAt(at('2026-09-27T04:00:00Z'), '07:00', 'Asia/Riyadh')), '2026-09-27T04:00:00.000Z', 'at the instant, it is today’s');
        assert.equal(iso(latestRunAt(at('2026-09-27T03:59:00Z'), '07:00', 'Asia/Riyadh')), '2026-09-26T04:00:00.000Z', 'a minute before, yesterday’s');
        assert.equal(iso(nextRunAt(at('2026-09-27T03:59:00Z'), '07:00', 'Asia/Riyadh')), '2026-09-27T04:00:00.000Z');
        assert.equal(iso(nextRunAt(at('2026-09-27T04:00:00Z'), '07:00', 'Asia/Riyadh')), '2026-09-28T04:00:00.000Z', 'strictly after now');
    });

    it('uses the local date, not the UTC one, where the two differ', () => {
        // 20:00Z on the 26th is already the 27th, 09:00, in Auckland.
        assert.equal(iso(latestRunAt(at('2026-09-26T20:00:00Z'), '07:00', 'Pacific/Auckland')), '2026-09-26T18:00:00.000Z');
    });

    it('keeps the local time through a daylight-saving change', () => {
        // New York leaves daylight saving on 1 November 2026: 07:00 is 11:00Z the day before, 12:00Z that day.
        const now = at('2026-11-01T11:30:00Z'); // 06:30 EST
        assert.equal(iso(latestRunAt(now, '07:00', 'America/New_York')), '2026-10-31T11:00:00.000Z');
        assert.equal(iso(nextRunAt(now, '07:00', 'America/New_York')), '2026-11-01T12:00:00.000Z');
        // Auckland enters it on 27 September 2026: yesterday's 07:00 was +12, today's is +13.
        assert.equal(iso(latestRunAt(at('2026-09-26T17:00:00Z'), '07:00', 'Pacific/Auckland')), '2026-09-25T19:00:00.000Z');
    });

    it('handles a run just before midnight, and the first of the month', () => {
        assert.equal(iso(latestRunAt(at('2026-10-01T00:10:00Z'), '23:30', 'UTC')), '2026-09-30T23:30:00.000Z');
        assert.equal(iso(nextRunAt(at('2026-09-30T23:40:00Z'), '23:30', 'UTC')), '2026-10-01T23:30:00.000Z');
    });
});

describe('enqueueDueMonteurScan', () => {
    let db: FakeDb;
    let monteur: Record<string, unknown> | null;
    let scans: { created_at: number; status: string; folder?: string; files?: boolean }[];
    let restoreSink: (() => void) | undefined;

    before(() => {
        const previous = setLogSink(() => {});
        restoreSink = () => setLogSink(previous);
    });
    after(() => restoreSink?.());

    beforeEach(() => {
        db = installFakeDb();
        monteur = { enabled: true, folder: '/Users/me/Movies/Monteur', run_at: '07:00', videos_per_run: 2 };
        scans = [];
        sourcePaths = ['/c/1.1.mp4'];
        db.routes.push(
            courseRoute,
            [/FROM studio_settings/, () => ({ rows: [{ schedule: { timezone: 'Asia/Riyadh', slots: ['13:00'] }, monteur }] })],
            // The due check: a scan still open, or one that finished since the due instant for
            // the folder set now.
            // A course run (p[2] null) counts only a course scan; a folder run only one of its folder.
            [/^SELECT id FROM studio_jobs WHERE creator_id = \$1 AND kind = 'monteur_scan'/, (p) => ({
                rows: scans.filter((s) => ['pending', 'claimed'].includes(s.status)
                    || (s.status === 'done' && s.created_at >= (p[1] as Date).getTime()
                        && (p[2] === null ? s.files === true : !s.files && (s.folder ?? '/Users/me/Movies/Monteur') === p[2])))
                    .map(() => ({ id: 'scan' })),
            })],
            [/^SELECT content_key FROM monteur_sources/, () => ({ rows: [{ content_key: 'a'.repeat(40) }, { content_key: 'b'.repeat(40) }] })],
            [/^INSERT INTO studio_jobs/, (p) => ({ rows: [{ id: 'job-new', kind: p[1], status: 'pending', payload: JSON.parse(p[2]) }] })],
        );
    });
    afterEach(() => db.restore());

    const inserts = () => db.ran(/^INSERT INTO studio_jobs/);

    it('does nothing while the Monteur is off, or has no folder — without looking for scans', async () => {
        monteur = { ...monteur, enabled: false };
        assert.equal(await enqueueDueMonteurScan(TENANT, at('2026-09-27T09:00:00Z')), null);
        monteur = { ...monteur, enabled: true, folder: null };
        assert.equal(await enqueueDueMonteurScan(TENANT, at('2026-09-27T09:00:00Z')), null);
        assert.equal(db.ran(/FROM studio_jobs/).length, 0);
        assert.equal(inserts().length, 0);
    });

    it('queues the scan when today’s 07:00 has passed with no scan since, with the contract’s payload', async () => {
        scans = [{ created_at: at('2026-09-26T04:05:00Z'), status: 'done' }]; // yesterday's
        const job = await enqueueDueMonteurScan(TENANT, at('2026-09-27T04:00:30Z'));
        assert.equal(job?.id, 'job-new');
        const [insert] = inserts();
        assert.deepEqual(insert!.params.slice(0, 2), [TENANT, 'monteur_scan']);
        assert.deepEqual(JSON.parse(insert!.params[2]), {
            folder: '/Users/me/Movies/Monteur', limit: 2, known: ['a'.repeat(40), 'b'.repeat(40)],
            extensions: ['.mp4', '.mov', '.m4v', '.mkv', '.webm'], min_age_s: 60,
        });
        assert.deepEqual([...SCAN_EXTENSIONS], ['.mp4', '.mov', '.m4v', '.mkv', '.webm']);
        assert.equal(SCAN_MIN_AGE_S, 60);
        // Every poll reads this: the monteur section and the timezone, not the whole settings row.
        assert.match(db.statements[0]!.sql, /^SELECT monteur, schedule FROM studio_settings WHERE creator_id = \$1$/);
        const [check] = db.ran(/kind = 'monteur_scan'/);
        assert.equal(iso((check!.params[1] as Date).getTime()), '2026-09-27T04:00:00.000Z', 'due = today’s 07:00 Riyadh');
        // The fake evaluates the condition in JS, so pin the SQL that Postgres evaluates too.
        assert.match(check!.sql, /WHERE creator_id = \$1 AND kind = 'monteur_scan' AND \(status IN \('pending', 'claimed'\) OR \(status = 'done' AND created_at >= \$2 AND \(\(\$3::text IS NULL AND payload->'files' IS NOT NULL\) OR payload->>'folder' = \$3\)\)\) LIMIT 1$/);
        assert.equal(check!.params[2], '/Users/me/Movies/Monteur');
        assert.equal(db.ran(/FROM course_lessons/).length, 0, 'a folder run never reads the library');
    });

    it('scans a Mac that slept through 07:00 the next time it polls, once', async () => {
        scans = [{ created_at: at('2026-09-26T04:01:00Z'), status: 'done' }];
        const woke = at('2026-09-27T09:12:00Z'); // 12:12 in Riyadh
        assert.ok(await enqueueDueMonteurScan(TENANT, woke));
        scans.push({ created_at: woke, status: 'done' });
        assert.equal(await enqueueDueMonteurScan(TENANT, woke + 5_000), null, 'the next poll finds today’s');
        assert.equal(inserts().length, 1);
    });

    it('never piles up scans for a worker that was off: one when it is back, not one per missed day', async () => {
        scans = [{ created_at: at('2026-09-20T04:01:00Z'), status: 'done' }]; // a week ago
        assert.ok(await enqueueDueMonteurScan(TENANT, at('2026-09-27T05:00:00Z')));
        assert.equal(inserts().length, 1);
    });

    it('counts a Run now after 07:00 as today’s run, and one before it as yesterday’s', async () => {
        scans = [{ created_at: at('2026-09-27T05:30:00Z'), status: 'done' }]; // Run now at 08:30 Riyadh
        assert.equal(await enqueueDueMonteurScan(TENANT, at('2026-09-27T10:00:00Z')), null);
        scans = [{ created_at: at('2026-09-27T03:30:00Z'), status: 'done' }]; // at 06:30, before 07:00
        assert.ok(await enqueueDueMonteurScan(TENANT, at('2026-09-27T04:10:00Z')));
    });

    it('does not count a scan that failed or was cancelled today as today’s run', async () => {
        scans = [{ created_at: at('2026-09-27T04:02:00Z'), status: 'failed' }];
        assert.ok(await enqueueDueMonteurScan(TENANT, at('2026-09-27T05:00:00Z')));
    });

    it('scans the new folder the day the folder changed, though the old one was scanned already', async () => {
        scans = [{ created_at: at('2026-09-27T04:02:00Z'), status: 'done', folder: '/Users/me/Old' }];
        const job = await enqueueDueMonteurScan(TENANT, at('2026-09-27T05:00:00Z'));
        assert.equal((job?.payload as { folder: string }).folder, '/Users/me/Movies/Monteur');
    });

    it('waits while yesterday’s scan is still open, instead of queueing a second', async () => {
        scans = [{ created_at: at('2026-09-26T04:00:00Z'), status: 'pending' }];
        assert.equal(await enqueueDueMonteurScan(TENANT, at('2026-09-27T06:00:00Z')), null);
        assert.equal(inserts().length, 0);
    });

    describe('source: course', () => {
        it('takes the library’s next lessons with no source yet, in lesson order, and needs no folder', async () => {
            monteur = { ...monteur, source: 'course', folder: null };
            const job = await enqueueDueMonteurScan(TENANT, at('2026-09-27T05:00:00Z'));
            assert.equal(job?.id, 'job-new');
            assert.deepEqual(JSON.parse(inserts()[0]!.params[2]), {
                folder: null,
                // 1.1 is a source already; 1.2 before 1.10, numbers before G.
                files: ['/c/1.2.mp4', '/c/1.10.mp4', '/c/10.1.mp4', '/c/G.1.mp4'],
                limit: 2, known: ['a'.repeat(40), 'b'.repeat(40)],
                extensions: ['.mp4', '.mov', '.m4v', '.mkv', '.webm'], min_age_s: 60,
            });
            const [lessons] = db.ran(/FROM course_lessons/);
            assert.match(lessons!.sql, /WHERE l\.creator_id = \$1 AND NOT EXISTS \( SELECT 1 FROM monteur_sources s WHERE s\.creator_id = l\.creator_id AND s\.path = l\.video_path \)$/);
            assert.deepEqual(lessons!.params, [TENANT]);
            assert.equal(db.ran(/kind = 'monteur_scan'/)[0]!.params[2], null, 'a course run is counted by course scans');
        });

        it('sends a few lessons past videos_per_run, in case the worker already knows one by its content', async () => {
            monteur = { ...monteur, source: 'course', videos_per_run: 1 };
            sourcePaths = [];
            const many = Array.from({ length: 20 }, (_, i) => ({ video_path: `/c/${i + 1}.mp4`, lesson_no: `${i + 1}`, title: 't' }));
            db.routes.unshift([courseRoute[0], () => ({ rows: many })]);
            await enqueueDueMonteurScan(TENANT, at('2026-09-27T05:00:00Z'));
            const payload = JSON.parse(inserts()[0]!.params[2]);
            assert.equal(payload.limit, 1);
            assert.equal(payload.files.length, 1 + COURSE_LOOKAHEAD);
            assert.deepEqual(payload.files.slice(0, 3), ['/c/1.mp4', '/c/2.mp4', '/c/3.mp4']);
        });

        it('queues nothing once every lesson has a source', async () => {
            monteur = { ...monteur, source: 'course' };
            sourcePaths = LESSONS.map((l) => l.video_path);
            assert.equal(await enqueueDueMonteurScan(TENANT, at('2026-09-27T05:00:00Z')), null);
            assert.equal(inserts().length, 0);
        });

        it('counts only a course scan as today’s course run: the switch from a folder runs today', async () => {
            monteur = { ...monteur, source: 'course' };
            scans = [{ created_at: at('2026-09-27T04:02:00Z'), status: 'done' }]; // today's folder scan
            assert.ok(await enqueueDueMonteurScan(TENANT, at('2026-09-27T05:00:00Z')));
            scans = [{ created_at: at('2026-09-27T04:02:00Z'), status: 'done', files: true }];
            assert.equal(await enqueueDueMonteurScan(TENANT, at('2026-09-27T05:00:00Z')), null);
        });

        it('is off when the Monteur is off, library or not', async () => {
            monteur = { ...monteur, source: 'course', enabled: false };
            assert.equal(await enqueueDueMonteurScan(TENANT, at('2026-09-27T05:00:00Z')), null);
            assert.equal(db.ran(/FROM studio_jobs|FROM course_lessons/).length, 0);
        });
    });
});

describe('Run now and Choose folder', () => {
    let db: FakeDb;
    let monteur: Record<string, unknown>;
    let open: Record<string, unknown> | null;

    beforeEach(() => {
        db = installFakeDb();
        monteur = { enabled: false, folder: '/Volumes/Clips' };
        open = null;
        sourcePaths = ['/c/1.1.mp4'];
        db.routes.push(
            courseRoute,
            [/^SELECT content_key FROM monteur_sources/, () => ({ rows: [] })],
            [/FROM studio_settings/, () => ({ rows: [{ monteur, voice: { language: 'ar', digits: 'arabic-indic', guide: '' } }] })],
            [/status IN \('pending', 'claimed'\) AND \(\$3::text IS NULL/, () => ({ rows: open ? [open] : [] })],
            [/^INSERT INTO studio_jobs/, (p) => ({ rows: [{ id: 'job-new', kind: p[1], status: 'pending', payload: JSON.parse(p[2]) }] })],
        );
    });
    afterEach(() => db.restore());

    it('runs even with the daily run off, and refuses with 409 until a folder is chosen', async () => {
        const job = await runMonteurNow(TENANT);
        assert.equal(job.kind, 'monteur_scan');
        assert.equal((job.payload as { folder: string }).folder, '/Volumes/Clips');

        monteur = { enabled: true, folder: null };
        await assert.rejects(runMonteurNow(TENANT), (err: unknown) => err instanceof StudioError && err.status === 409);
    });

    it('course mode: runs with no folder, on the next lessons; refuses with 409 once none is left', async () => {
        monteur = { enabled: false, source: 'course', folder: null, videos_per_run: 1 };
        const job = await runMonteurNow(TENANT);
        assert.deepEqual((job.payload as { files: string[] }).files, ['/c/1.2.mp4', '/c/1.10.mp4', '/c/10.1.mp4', '/c/G.1.mp4']);
        assert.equal((job.payload as { folder: string | null }).folder, null);
        sourcePaths = LESSONS.map((l) => l.video_path);
        await assert.rejects(runMonteurNow(TENANT), (err: unknown) =>
            err instanceof StudioError && err.status === 409 && /course library/.test(err.message));
    });

    it('course mode: hands back an open course scan, and supersedes a pending folder one', async () => {
        monteur = { enabled: true, source: 'course', folder: '/Volumes/Clips', videos_per_run: 1 };
        open = { id: 'job-course', kind: 'monteur_scan', status: 'pending', payload: { folder: null, files: ['/c/1.2.mp4'] } };
        assert.equal((await runMonteurNow(TENANT)).id, 'job-course');
        open = { id: 'job-folder', kind: 'monteur_scan', status: 'pending', payload: { folder: '/Volumes/Clips' } };
        const job = await runMonteurNow(TENANT);
        assert.equal(job.id, 'job-new');
        const [superseded] = db.ran(/^UPDATE studio_jobs SET status = 'failed'/);
        assert.deepEqual(superseded!.params.slice(0, 2), ['job-folder', TENANT]);
    });

    it('folder mode: a course scan still open is not the folder’s', async () => {
        open = { id: 'job-course', kind: 'monteur_scan', status: 'pending', payload: { folder: null, files: ['/c/1.2.mp4'] } };
        assert.equal((await runMonteurNow(TENANT)).id, 'job-new');
    });

    it('returns the open scan instead of queueing a second', async () => {
        open = { id: 'job-open', kind: 'monteur_scan', status: 'claimed', payload: { folder: '/Volumes/Clips' } };
        assert.equal((await runMonteurNow(TENANT)).id, 'job-open');
        assert.equal(db.ran(/^INSERT INTO studio_jobs/).length, 0);
    });

    it('replaces a folder dialog nobody picked up within 10 minutes, rather than handing it back', async () => {
        open = { id: 'job-old', kind: 'pick_folder', status: 'pending', payload: {}, created_at: new Date(Date.now() - 11 * 60_000) };
        const job = await requestFolderPick(TENANT);
        assert.equal(job.id, 'job-new');
        const [expire] = db.ran(/^UPDATE studio_jobs SET status = 'failed'/);
        assert.deepEqual(expire!.params.slice(0, 2), ['job-old', TENANT]);
        assert.match(expire!.params[2], /Nobody was waiting for the folder dialog/);
        open = { id: 'job-shown', kind: 'pick_folder', status: 'claimed', payload: {}, created_at: new Date(Date.now() - 11 * 60_000) };
        assert.equal((await requestFolderPick(TENANT)).id, 'job-shown', 'one on screen now is left alone');
    });

    it('asks the worker for the folder dialog in the tenant’s language, once at a time', async () => {
        const job = await requestFolderPick(TENANT);
        assert.equal(job.kind, 'pick_folder');
        assert.match((job.payload as { prompt: string }).prompt, /المونتير/);
        open = { id: 'job-open', kind: 'pick_folder', status: 'pending', payload: {}, created_at: new Date() };
        assert.equal((await requestFolderPick(TENANT)).id, 'job-open');
    });
});
