/**
 * The Studio queue: the claim, and what each result does to the lessons and drafts.
 *
 * Two kinds of assertion, as in src/jobs/queue.test.ts. Behavioural ones run the services
 * against a pool that answers by SQL, with no database. Structural ones check SQL text where
 * the guarantee lives in Postgres rather than in TypeScript: the claim's SKIP LOCKED and its
 * tenant filter, the attempt ceiling, the "unless a scheduled post uses it" on every delete.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setLogSink } from '../../utils/log.js';
import { StudioError } from './common.js';
import {
    CLAIM_SQL, claimJob, completeJob, enqueueRender, EXHAUSTED_ERROR, failJob, MAX_ATTEMPTS, parseScanResult,
    reportProgress, STALE_CLAIM_MINUTES,
} from './jobs.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const JOB = '55555555-5555-4555-8555-555555555555';
const NEWER_JOB = '56565656-5656-4565-8565-565656565656';
const LESSON = '66666666-6666-4666-8666-666666666666';
const DRAFT = '77777777-7777-4777-8777-777777777777';
const uploadId = (prefix: string) => `${prefix}111111-1111-4111-8111-111111111111`;
const IG1 = uploadId('a1');
const IG2 = uploadId('a2');
const TT1 = uploadId('b1');
const TT2 = uploadId('b2');
const OLD1 = uploadId('c1');
const OLD2 = uploadId('c2');
const up = (id: string) => `https://msg-response-auto.vercel.app/api/uploads/${id}`;

type Rows = { rows: any[]; rowCount?: number };
interface Statement { sql: string; params: any[] }
let statements: Statement[] = [];
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
});

const ran = (pattern: RegExp) => statements.filter((s) => pattern.test(s.sql));
const LOCK = /^SELECT id, creator_id, kind, status, payload FROM studio_jobs/;
const LATEST = /ORDER BY created_at DESC, id DESC LIMIT 1/;

function lockReturns(job: Record<string, unknown>) {
    routes.push([LOCK, (params) => ({ rows: params[0] === job.id && params[1] === TENANT ? [{ creator_id: TENANT, ...job }] : [] })]);
}

const isStudioError = (status: number) => (err: unknown) => err instanceof StudioError && err.status === status;

// ─── Claim ──────────────────────────────────────────────────────────────────────────────

describe('claim — the SQL', () => {
    it('locks with SKIP LOCKED, so two claimers split the work instead of taking one job twice', () => {
        assert.match(CLAIM_SQL, /FOR UPDATE SKIP LOCKED/);
        assert.match(CLAIM_SQL, /LIMIT 1/);
        // No window function: Postgres rejects FOR UPDATE beside one (FLOWS.md §5.2).
        assert.doesNotMatch(CLAIM_SQL, /OVER \(/);
    });

    it('only ever looks at the worker’s own tenant', () => {
        assert.match(CLAIM_SQL, /WHERE creator_id = \$1/);
    });

    it('takes a pending job, or a claimed one gone quiet for 15 minutes with claims left, oldest first', () => {
        const sql = CLAIM_SQL.replace(/\s+/g, ' ');
        assert.match(sql, /status = 'pending' OR \(status = 'claimed' AND COALESCE\(heartbeat_at, claimed_at, created_at\) < NOW\(\) - make_interval\(mins => \$2\) AND attempts < \$3\)/);
        assert.match(sql, /ORDER BY CASE kind WHEN 'render_carousel' THEN 0 WHEN 'scan_library' THEN 1 ELSE 2 END, created_at, id/,
            'renders first: someone is waiting at the editor, while indexing is an hour-long backlog');
        assert.match(sql, /attempts = j\.attempts \+ 1/);
        assert.match(sql, /heartbeat_at = NOW\(\)/);
    });
});

describe('claimJob', () => {
    it('passes the tenant, the 15-minute window and the 3-claim ceiling, and hands back id, kind and payload', async () => {
        routes.push([/^WITH picked AS/, () => ({ rows: [{ id: JOB, kind: 'scan_library', payload: { root: '/r' }, attempts: 1 }] })]);
        assert.deepEqual(await claimJob(TENANT), { id: JOB, kind: 'scan_library', payload: { root: '/r' } });
        const [claim] = ran(/^WITH picked AS/);
        assert.deepEqual(claim!.params, [TENANT, STALE_CLAIM_MINUTES, MAX_ATTEMPTS]);
        assert.equal(STALE_CLAIM_MINUTES, 15);
        assert.equal(MAX_ATTEMPTS, 3);
    });

    it('returns null when there is nothing to do', async () => {
        assert.equal(await claimJob(TENANT), null);
    });

    it('first fails a claim that went quiet a third time, lesson included, instead of claiming it a fourth', async () => {
        routes.push([/SET status = 'failed', error = \$4/, () => ({
            rows: [{ id: JOB, creator_id: TENANT, kind: 'index_lesson', status: 'failed', payload: { lessonId: LESSON } }],
        })]);
        await claimJob(TENANT);

        const [exhaust] = ran(/SET status = 'failed', error = \$4/);
        assert.match(exhaust!.sql, /status = 'claimed'/);
        assert.match(exhaust!.sql, /attempts >= \$3/);
        assert.deepEqual(exhaust!.params, [TENANT, STALE_CLAIM_MINUTES, MAX_ATTEMPTS, EXHAUSTED_ERROR]);

        const [lesson] = ran(/^UPDATE course_lessons SET status = 'failed'/);
        assert.deepEqual(lesson!.params, [LESSON, TENANT, EXHAUSTED_ERROR]);
        // The reaping happens before the claim, so the claim cannot pick the row up again.
        const order = statements.map((s) => s.sql);
        assert.ok(order.findIndex((s) => /attempts >= \$3/.test(s)) < order.findIndex((s) => /^WITH picked AS/.test(s)));
    });
});

// ─── Progress ───────────────────────────────────────────────────────────────────────────

describe('reportProgress', () => {
    it('is the heartbeat, keeping the last line when none is sent', async () => {
        routes.push([/^UPDATE studio_jobs SET progress/, () => ({ rows: [], rowCount: 1 })]);
        await reportProgress(TENANT, JOB, null);
        const [update] = ran(/^UPDATE studio_jobs SET progress/);
        assert.match(update!.sql, /progress = COALESCE\(\$3, progress\), heartbeat_at = NOW\(\)/);
        assert.match(update!.sql, /WHERE id = \$1 AND creator_id = \$2 AND status = 'claimed'/);
    });

    it('tells the worker to stop when the job is no longer claimed, and 404s one that is not its tenant’s', async () => {
        routes.push([/^SELECT status FROM studio_jobs/, (params) => ({ rows: params[0] === JOB ? [{ status: 'failed' }] : [] })]);
        await assert.rejects(reportProgress(TENANT, JOB, 'frame 3'), isStudioError(409));
        await assert.rejects(reportProgress(TENANT, NEWER_JOB, 'frame 3'), isStudioError(404));
    });
});

// ─── Complete ───────────────────────────────────────────────────────────────────────────

describe('completeJob — the lifecycle', () => {
    it('404s a job that is not this tenant’s, writing nothing', async () => {
        lockReturns({ id: JOB, kind: 'scan_library', status: 'claimed', payload: { root: '/r' } });
        await assert.rejects(completeJob('99999999-9999-4999-8999-999999999999', JOB, { lessons: [] }), isStudioError(404));
        assert.equal(ran(/^(INSERT|UPDATE|DELETE)/).length, 0);
    });

    it('answers a repeated delivery of a finished job without applying it twice', async () => {
        lockReturns({ id: JOB, kind: 'scan_library', status: 'done', payload: { root: '/r' } });
        assert.equal(await completeJob(TENANT, JOB, { lessons: [] }), 'already_done');
        assert.equal(ran(/^(INSERT|UPDATE|DELETE)/).length, 0);
    });

    it('refuses a job that is pending or failed', async () => {
        lockReturns({ id: JOB, kind: 'scan_library', status: 'failed', payload: { root: '/r' } });
        await assert.rejects(completeJob(TENANT, JOB, { lessons: [] }), isStudioError(409));
    });
});

describe('completeJob — scan_library', () => {
    const lesson = (path: string, title = 'Title') => ({
        lesson_no: '1.2', section_no: 1, section_title: 'Chapter 1', title, video_path: path, duration_s: 312.5,
    });

    it('upserts by video_path and never deletes', async () => {
        lockReturns({ id: JOB, kind: 'scan_library', status: 'claimed', payload: { root: '/r' } });
        await completeJob(TENANT, JOB, { lessons: [lesson('/r/a.mp4'), lesson('/r/b.mp4')] });

        const [upsert] = ran(/^INSERT INTO course_lessons/);
        assert.match(upsert!.sql, /ON CONFLICT \(creator_id, video_path\) DO UPDATE/);
        assert.equal(upsert!.params[0], TENANT);
        assert.deepEqual(JSON.parse(upsert!.params[1]).map((l: any) => l.video_path), ['/r/a.mp4', '/r/b.mp4']);
        assert.equal(ran(/^DELETE/).length, 0, 'a file gone from the Mac keeps its lesson');

        const [done] = ran(/SET status = 'done'/);
        assert.deepEqual(JSON.parse(done!.params[1]), { lessons: 2, skipped: [] });
    });

    it('keeps the last entry for a repeated path, which ON CONFLICT could not update twice', () => {
        const { lessons } = parseScanResult({ lessons: [lesson('/r/a.mp4', 'Old'), lesson('/r/a.mp4', 'New')] });
        assert.deepEqual(lessons.map((l) => l.title), ['New']);
    });

    it('skips an entry it cannot read, and names it, rather than refusing the whole library', () => {
        const { lessons, skipped } = parseScanResult({ lessons: [lesson('/r/a.mp4'), { ...lesson('relative.mp4') }, 'junk'] });
        assert.equal(lessons.length, 1);
        assert.equal(skipped.length, 2);
        assert.match(skipped[0]!, /lessons\[1\].*absolute path/);
    });

    it('refuses a result that is not { lessons: [...] }', () => {
        assert.throws(() => parseScanResult({ files: [] }), isStudioError(400));
    });
});

describe('completeJob — index_lesson', () => {
    const notes = {
        summary: 'ملخص', points: [{ title: 'فكرة', detail: 'تفصيل', t: 12 }],
        prompts: [{ text: 'prompt' }], tools: ['NotebookLM'], demos: [{ title: 'Demo', result: 'Works' }],
    };
    const moment = (t: number) => ({ t, description: 'Screen', kind: 'ui', clean: true, thumb_url: up(IG1) });

    beforeEach(() => {
        lockReturns({ id: JOB, kind: 'index_lesson', status: 'claimed', payload: { lessonId: LESSON } });
        routes.push([/^SELECT id FROM course_lessons WHERE id = \$1 AND creator_id = \$2 FOR UPDATE/, () => ({ rows: [{ id: LESSON }] })]);
    });

    it('replaces the moments, sets the notes, and marks the lesson indexed', async () => {
        await completeJob(TENANT, JOB, { notes, moments: [moment(3), moment(40)] });

        const [del] = ran(/^DELETE FROM lesson_moments/);
        assert.deepEqual(del!.params, [LESSON]);
        const [insert] = ran(/^INSERT INTO lesson_moments/);
        assert.equal(insert!.params[0], LESSON);
        assert.deepEqual(JSON.parse(insert!.params[1]).map((m: any) => m.t), [3, 40]);
        const [lesson] = ran(/^UPDATE course_lessons SET notes/);
        assert.match(lesson!.sql, /status = 'indexed', indexed_at = NOW\(\), error = NULL/);
        assert.equal(JSON.parse(lesson!.params[1]).summary, 'ملخص');
        // Delete before insert, or the new moments would be the ones deleted.
        const order = statements.map((s) => s.sql);
        assert.ok(order.findIndex((s) => /^DELETE FROM lesson_moments/.test(s)) < order.findIndex((s) => /^INSERT INTO lesson_moments/.test(s)));
    });

    it('refuses a malformed result whole, with the problems, and leaves the old moments in place', async () => {
        await assert.rejects(
            completeJob(TENANT, JOB, { notes: { summary: '' }, moments: [{ t: -1, description: '', kind: 'poster' }] }),
            (err: unknown) => err instanceof StudioError && err.status === 400
                && (err.problems ?? []).some((p) => /summary/.test(p))
                && (err.problems ?? []).some((p) => /moments\[0\]\.kind/.test(p))
        );
        assert.equal(ran(/^(DELETE|INSERT|UPDATE)/).length, 0);
    });
});

describe('completeJob — render_carousel', () => {
    const payload = { draftId: DRAFT, carousel: { slides: [{ kind: 'cover' }, { kind: 'cta' }] }, shots: {} };
    const result = { ig: [up(IG1), up(IG2)], tt: [up(TT1), up(TT2)] };
    let latest = JOB;
    let draftStatus = 'rendering';

    beforeEach(() => {
        latest = JOB;
        draftStatus = 'rendering';
        lockReturns({ id: JOB, kind: 'render_carousel', status: 'claimed', payload });
        routes.push([/^SELECT id FROM media_uploads/, (params) => ({ rows: params[0].map((id: string) => ({ id })) })]);
        routes.push([/^SELECT id, status, render FROM carousel_drafts/, () => ({
            rows: [{ id: DRAFT, status: draftStatus, render: { ig: [up(OLD1)], tt: [up(OLD2)], rendered_at: 'x', job_id: 'old' } }],
        })]);
        routes.push([LATEST, () => ({ rows: [{ id: latest }] })]);
        routes.push([/^DELETE FROM media_uploads/, (params) => ({ rows: [], rowCount: params[1].length })]);
    });

    it('lands the render on the draft, marks it ready, and deletes the previous render’s uploads', async () => {
        assert.equal(await completeJob(TENANT, JOB, result), 'applied');

        const [land] = ran(/^UPDATE carousel_drafts SET render/);
        assert.match(land!.sql, /status = 'ready'/);
        const render = JSON.parse(land!.params[1]);
        assert.deepEqual(render.ig, result.ig);
        assert.deepEqual(render.tt, result.tt);
        assert.equal(render.job_id, JOB);
        assert.ok(render.rendered_at);

        const [del] = ran(/^DELETE FROM media_uploads/);
        assert.deepEqual(del!.params, [TENANT, [OLD1, OLD2]]);
        // Unless a scheduled post still names one, in any state.
        assert.match(del!.sql, /NOT EXISTS \( SELECT 1 FROM scheduled_posts s/);
        assert.match(del!.sql, /array_to_string\(s\.media_urls, ' '\)/);
        assert.match(del!.sql, /m\.creator_id = \$1/);
    });

    it('drops a stale result — an edit queued a newer render meanwhile — and deletes its uploads', async () => {
        latest = NEWER_JOB;
        assert.equal(await completeJob(TENANT, JOB, result), 'dropped');

        assert.equal(ran(/^UPDATE carousel_drafts/).length, 0, 'the draft keeps waiting for the newer render');
        const [del] = ran(/^DELETE FROM media_uploads/);
        assert.deepEqual(del!.params, [TENANT, [IG1, IG2, TT1, TT2]]);
        const [done] = ran(/SET status = 'done'/);
        assert.equal(JSON.parse(done!.params[1]).dropped, 'superseded');
    });

    it('drops a result for a draft that was scheduled meanwhile', async () => {
        draftStatus = 'scheduled';
        assert.equal(await completeJob(TENANT, JOB, result), 'dropped');
        assert.equal(ran(/^UPDATE carousel_drafts/).length, 0);
    });

    it('refuses a render with a slide missing, before touching the draft', async () => {
        await assert.rejects(
            completeJob(TENANT, JOB, { ig: [up(IG1)], tt: result.tt }),
            (err: unknown) => err instanceof StudioError && err.status === 400
                && (err.problems ?? []).some((p) => /ig has 1 images for 2 slides/.test(p))
        );
        assert.equal(ran(/^(UPDATE carousel_drafts|DELETE)/).length, 0);
    });

    it('refuses a render naming an upload this tenant does not own', async () => {
        routes.unshift([/^SELECT id FROM media_uploads/, () => ({ rows: [{ id: IG1 }, { id: IG2 }, { id: TT1 }] })]);
        await assert.rejects(completeJob(TENANT, JOB, result), (err: unknown) =>
            err instanceof StudioError && err.status === 400 && (err.problems ?? []).some((p) => p.includes(TT2)));
    });
});

// ─── Fail ───────────────────────────────────────────────────────────────────────────────

describe('failJob', () => {
    it('fails the job, and its lesson with the worker’s error', async () => {
        lockReturns({ id: JOB, kind: 'index_lesson', status: 'claimed', payload: { lessonId: LESSON } });
        await failJob(TENANT, JOB, 'Gemini refused the file');
        assert.deepEqual(ran(/^UPDATE studio_jobs SET status = 'failed'/)[0]!.params, [JOB, 'Gemini refused the file']);
        assert.deepEqual(ran(/^UPDATE course_lessons SET status = 'failed'/)[0]!.params, [LESSON, TENANT, 'Gemini refused the file']);
    });

    it('fails the draft only when this is its latest render', async () => {
        lockReturns({ id: JOB, kind: 'render_carousel', status: 'claimed', payload: { draftId: DRAFT } });
        routes.push([LATEST, () => ({ rows: [{ id: JOB }] })]);
        await failJob(TENANT, JOB, 'Remotion crashed');
        const [draft] = ran(/^UPDATE carousel_drafts SET status = 'failed'/);
        assert.deepEqual(draft!.params, [DRAFT, TENANT, 'Remotion crashed']);
        assert.match(draft!.sql, /status <> 'scheduled'/);
    });

    it('leaves the draft alone when a newer render is on its way', async () => {
        lockReturns({ id: JOB, kind: 'render_carousel', status: 'claimed', payload: { draftId: DRAFT } });
        routes.push([LATEST, () => ({ rows: [{ id: NEWER_JOB }] })]);
        await failJob(TENANT, JOB, 'Remotion crashed');
        assert.equal(ran(/^UPDATE carousel_drafts/).length, 0);
    });

    it('is a no-op on a job already failed, and refused on one that finished', async () => {
        lockReturns({ id: JOB, kind: 'scan_library', status: 'failed', payload: {} });
        await failJob(TENANT, JOB, 'again');
        assert.equal(ran(/^UPDATE/).length, 0);

        routes = [];
        lockReturns({ id: JOB, kind: 'scan_library', status: 'done', payload: {} });
        await assert.rejects(failJob(TENANT, JOB, 'late'), isStudioError(409));
    });
});

// ─── Enqueue a render ───────────────────────────────────────────────────────────────────

describe('enqueueRender', () => {
    it('fails renders of the same draft still pending, queues this one, and marks the draft rendering', async () => {
        routes.push([/^INSERT INTO studio_jobs/, () => ({ rows: [{ id: NEWER_JOB, kind: 'render_carousel', status: 'pending' }] })]);
        routes.push([/^UPDATE carousel_drafts SET status = 'rendering'/, () => ({ rows: [{ id: DRAFT, status: 'rendering' }] })]);
        const payload = {
            draftId: DRAFT, carousel: {} as never, shots: {}, brand: {} as never, cta: {} as never, facts: [],
        };
        const { job, draft } = await enqueueRender(pool as never, TENANT, payload);
        assert.equal(job.id, NEWER_JOB);
        assert.equal(draft?.status, 'rendering');

        const [supersede] = ran(/^UPDATE studio_jobs SET status = 'failed'/);
        assert.match(supersede!.sql, /kind = 'render_carousel' AND status = 'pending' AND payload->>'draftId' = \$2/);
        assert.deepEqual(supersede!.params.slice(0, 2), [TENANT, DRAFT]);
        const order = statements.map((s) => s.sql);
        assert.ok(order.findIndex((s) => /^UPDATE studio_jobs/.test(s)) < order.findIndex((s) => /^INSERT INTO studio_jobs/.test(s)),
            'superseding after the insert would fail the new job too');
    });
});
