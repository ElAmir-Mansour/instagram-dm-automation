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
    enqueueDueMonteurScan, latestRunAt, nextRunAt, requestFolderPick, runMonteurNow, SCAN_EXTENSIONS, SCAN_MIN_AGE_S,
} from './daily.js';
import { installFakeDb, type FakeDb } from './testDb.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const at = (iso: string) => Date.parse(iso);
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
    let scans: { created_at: number; status: string }[];
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
        db.routes.push(
            [/FROM studio_settings/, () => ({ rows: [{ schedule: { timezone: 'Asia/Riyadh', slots: ['13:00'] }, monteur }] })],
            // The due check: a scan created at or after the due instant, or one still open.
            [/^SELECT id FROM studio_jobs WHERE creator_id = \$1 AND kind = 'monteur_scan'/, (p) => ({
                rows: scans.filter((s) => s.created_at >= (p[1] as Date).getTime() || ['pending', 'claimed'].includes(s.status))
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
        assert.match(check!.sql, /WHERE creator_id = \$1 AND kind = 'monteur_scan' AND \(created_at >= \$2 OR status IN \('pending', 'claimed'\)\) LIMIT 1$/);
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

    it('waits while yesterday’s scan is still open, instead of queueing a second', async () => {
        scans = [{ created_at: at('2026-09-26T04:00:00Z'), status: 'pending' }];
        assert.equal(await enqueueDueMonteurScan(TENANT, at('2026-09-27T06:00:00Z')), null);
        assert.equal(inserts().length, 0);
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
        db.routes.push(
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

    it('returns the open scan instead of queueing a second', async () => {
        open = { id: 'job-open', kind: 'monteur_scan', status: 'claimed', payload: { folder: '/Volumes/Clips' } };
        assert.equal((await runMonteurNow(TENANT)).id, 'job-open');
        assert.equal(db.ran(/^INSERT INTO studio_jobs/).length, 0);
    });

    it('asks the worker for the folder dialog in the tenant’s language, once at a time', async () => {
        const job = await requestFolderPick(TENANT);
        assert.equal(job.kind, 'pick_folder');
        assert.match((job.payload as { prompt: string }).prompt, /المونتير/);
        open = { id: 'job-open', kind: 'pick_folder', status: 'pending', payload: {} };
        assert.equal((await requestFolderPick(TENANT)).id, 'job-open');
    });
});
