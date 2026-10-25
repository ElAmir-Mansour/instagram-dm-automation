/**
 * Who writes an explainer's script (writing.ts): Claude on the Mac, and Gemini on the server in the three cases that are the only ones (the owner chose it,
 * the Mac is signed out, the Mac has not picked the job up in ten minutes). The takeover is one transaction that takes the explainer's lock first, closes the
 * Mac's job, writes Gemini's own and points the explainer at it; the run starts after the commit and ends the way the Mac's job does, through `completeJob`
 * or `failJob`. Nothing here reaches Gemini: the run's model call is injected.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import type { ExplainerRow } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { setWaitUntil } from '../../utils/waitUntil.js';
import { completeJob, failJob } from '../studio/jobs.js';
import { EXPLAINER, JOB, TENANT, validWriterOutput } from './testFixtures.js';
import { explainerSettings, installWorld, type World } from './testDb.js';
import { GeminiWriteError, type GeminiWriteArgs, type GeminiWritten } from './writerGemini.js';
import {
    afterJobFailed, insertServerWriteJob, isSignInFailure, queueWrite, reapStalledRun, reconcileWriting, runGeminiWrite, setRunDeps, setRunLauncher, startGeminiRun, sweepWriting,
    takeOverWrite, STALLED_RUN_MINUTES, UNCLAIMED_MINUTES, type GeminiRun,
} from './writing.js';

const KARIM = { key: 'karim', name: 'Karim', description: 'a curious young man', ref_media_id: null, ref_url: null, approved_at: null };
const NOW = Date.parse('2026-10-25T12:00:00Z');
const minutesAgo = (n: number, from = NOW): Date => new Date(from - n * 60_000);
const SIGNED_OUT = 'claude answered with an error: Failed to authenticate: OAuth session expired and could not be refreshed';

let world: World;
let logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
let restoreSink: (() => void) | undefined;
let launched: { run: GeminiRun; work: Promise<void> }[] = [];
let restoreLauncher: (() => void) | undefined;
before(() => {
    const previous = setLogSink((level, line) => { const { ts: _ts, level: _l, event, ...fields } = JSON.parse(line); logs.push({ level, event, fields }); });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());
beforeEach(() => {
    logs = [];
    world = installWorld();
    world.settingsRow = explainerSettings({ characters: [KARIM] });
    launched = [];
    const previous = setRunLauncher(() => undefined);
    const previousDeps = setRunDeps(null);
    // Every run the code starts is recorded, with the promise of its work, and its model call is the test's.
    let calls = 0;
    setRunLauncher((work) => { launched.push({ run: { creatorId: TENANT, explainerId: EXPLAINER, jobId: `run-${++calls}` }, work }); });
    setRunDeps({ write: async () => { throw new GeminiWriteError('no Gemini in this test', 'research'); } });
    restoreLauncher = () => { setRunLauncher(previous); setRunDeps(previousDeps); };
});
afterEach(() => {
    world.restore();
    restoreLauncher?.();
});

/** A writing explainer whose Mac job is `pending` and was queued `age` minutes before `NOW`. */
function macWriting(age: number, over: Partial<ExplainerRow> = {}, jobOver: object = {}) {
    const job = world.addJob({ id: JOB, kind: 'explainer_write', status: 'pending', payload: { explainer_id: EXPLAINER }, created_at: minutesAgo(age), ...jobOver });
    world.addExplainer({ status: 'writing', job_id: job.id, title: null, draft: null, draft_version: 0, ...over });
    return job;
}

const geminiJobs = () => world.jobsOf('explainer_write').filter((j) => j.payload.writer === 'gemini');

// ─── The Mac's sign-in failure ─────────────────────────────────────────────────────────────────

describe('isSignInFailure', () => {
    it('knows what the worker reports when the Claude CLI is signed out: the text in its own log, and the older, shorter forms of the same refusal', () => {
        for (const text of [
            SIGNED_OUT,
            'Failed to authenticate: OAuth session expired and could not be refreshed',
            'claude answered with an error (error_during_execution): Not logged in · Please run /login',
            'Invalid API key · Please run /login',
            'claude answered with an error: OAuth token has expired. Please obtain a new token or refresh your existing token.',
            'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
            'claude answered with an error: Please run /login to sign in again',
        ]) assert.equal(isSignInFailure(text), true, text);
    });

    it('is conservative: a spent weekly allowance, a rate limit, a draft that does not fit, a model error, a draft about OAuth and Gemini’s own refusals are not a sign-in', () => {
        for (const text of [
            'claude answered with an error: You\'ve hit your weekly limit · resets 11am (Africa/Cairo)',
            'claude answered with an error: Credit balance is too low',
            'claude answered with an error: rate_limit_error: This request would exceed your rate limit',
            'Claude\'s draft doesn\'t fit the schema, even after one repair: scenes[3].narration is 310 characters; at most 300 are allowed',
            'claude answered with an error (error_max_turns): the research used all 60 turns before the answer was written; run it again',
            'claude didn\'t answer within 20 min',
            'the answer is text, not the JSON object the schema describes',
            'The draft explains OAuth 2.0 and how a session expires',
            'Gemini refused the research call on every model it tried (HTTP 401: API key not valid. Please pass a valid API key.)',
            'HTTP 401', 'OAuth', 'authenticate', 'login', '', '   ',
        ]) assert.equal(isSignInFailure(text), false, text);
        assert.equal(isSignInFailure(null), false);
        assert.equal(isSignInFailure(undefined), false);
    });
});

// ─── Queueing ──────────────────────────────────────────────────────────────────────────────────

describe('insertServerWriteJob and queueWrite', () => {
    it('Gemini’s job is written already claimed, by the server, with every attempt spent, and a payload that says who it is for', async () => {
        const row = world.addExplainer({ status: 'writing' });
        const job = await insertServerWriteJob(pool, TENANT, row);
        const stored = world.jobs.find((j) => j.id === job.id)!;
        assert.deepEqual([stored.kind, stored.status, stored.attempts, stored.progress], ['explainer_write', 'claimed', 3, 'Gemini is writing it']);
        assert.deepEqual(stored.payload, { explainer_id: EXPLAINER, language: 'en', length_tier: 'short', topic: 'Why AI makes things up', writer: 'gemini' });
        assert.ok(stored.heartbeat_at, 'it has a heartbeat, which is the proof the run is alive');
    });

    it('queues Claude’s job for the Mac by default, with the contract payload, and Gemini’s when the settings or the caller say so', async () => {
        const row = world.addExplainer({ status: 'writing' });
        const settings = (await import('../studio/settings.js')).getStudioSettings;
        const s = await settings(TENANT);
        const mac = await queueWrite(pool, row, s, { today: '2026-10-25' });
        assert.equal(mac.writer, 'claude_mac');
        assert.equal(world.jobs.find((j) => j.id === mac.jobId)!.status, 'pending');
        assert.ok(world.jobs.find((j) => j.id === mac.jobId)!.payload.write.system);
        const gemini = await queueWrite(pool, row, s, { today: '2026-10-25', writer: 'gemini' });
        assert.equal(gemini.writer, 'gemini');
        assert.equal(world.jobs.find((j) => j.id === gemini.jobId)!.status, 'claimed');
        world.settingsRow = explainerSettings({ writer: 'gemini' });
        const fromSettings = await queueWrite(pool, row, await settings(TENANT), { today: '2026-10-25' });
        assert.equal(fromSettings.writer, 'gemini');
    });
});

// ─── The takeover ──────────────────────────────────────────────────────────────────────────────

describe('takeOverWrite: the Mac has not picked the job up', () => {
    it('after ten minutes: the Mac’s job is closed, Gemini’s own is written, and the explainer is Gemini’s, with the reason as its note', async () => {
        const mac = macWriting(UNCLAIMED_MINUTES + 1);
        const run = await takeOverWrite(TENANT, EXPLAINER, NOW);
        assert.ok(run);
        assert.deepEqual([mac.status, mac.error], ['failed', `The Mac did not pick this up in ${UNCLAIMED_MINUTES} minutes, so Gemini is writing it.`]);
        const [gemini] = geminiJobs();
        assert.equal(run!.jobId, gemini!.id);
        assert.equal(gemini!.status, 'claimed');
        const row = world.explainer();
        assert.equal(row.status, 'writing');
        assert.equal(row.job_id, gemini!.id, 'only the result of this job is applied now: a late answer from the Mac is dropped');
        assert.equal(row.error, mac.error);
        assert.deepEqual(run, { creatorId: TENANT, explainerId: EXPLAINER, jobId: gemini!.id });
    });

    it('is not a takeover before ten minutes, while the Mac holds the job, or once the job is anything but pending', async () => {
        macWriting(UNCLAIMED_MINUTES - 1);
        assert.equal(await takeOverWrite(TENANT, EXPLAINER, NOW), null, 'nine minutes: the Mac may still come');
        world.jobs.length = 0;
        world.explainers.clear();
        macWriting(30, {}, { status: 'claimed', claimed_at: minutesAgo(25), heartbeat_at: minutesAgo(1) });
        assert.equal(await takeOverWrite(TENANT, EXPLAINER, NOW), null, 'the Mac is writing it: a long research is not "unclaimed"');
        for (const status of ['done', 'failed'] as const) {
            world.jobs.length = 0;
            world.explainers.clear();
            macWriting(30, {}, { status });
            assert.equal(await takeOverWrite(TENANT, EXPLAINER, NOW), null, status);
        }
        assert.equal(geminiJobs().length, 0);
    });

    it('does not take a job whose explainer is gone, one that is not writing, or one with no job', async () => {
        assert.equal(await takeOverWrite(TENANT, EXPLAINER, NOW), null);
        world.addExplainer({ status: 'draft', job_id: null });
        assert.equal(await takeOverWrite(TENANT, EXPLAINER, NOW), null);
        world.explainers.clear();
        world.addExplainer({ status: 'writing', job_id: null });
        assert.equal(await takeOverWrite(TENANT, EXPLAINER, NOW), null);
        world.explainers.clear();
        world.addExplainer({ status: 'writing', job_id: world.uuid() });
        assert.equal(await takeOverWrite(TENANT, EXPLAINER, NOW), null, 'a job that is not in the queue is not an unclaimed one');
    });

    it('is another tenant’s explainer: not found, not taken', async () => {
        macWriting(30);
        assert.equal(await takeOverWrite('77777777-7777-4777-8777-777777777777', EXPLAINER, NOW), null);
        assert.equal(geminiJobs().length, 0);
    });

    it('never, when the owner turned the fallback off: the explainer waits for the Mac', async () => {
        world.settingsRow = explainerSettings({ characters: [KARIM], writer_fallback: false });
        const mac = macWriting(60);
        assert.equal(await takeOverWrite(TENANT, EXPLAINER, NOW), null);
        assert.equal(mac.status, 'pending', 'the Mac’s job is still there for it to take');
        assert.equal(geminiJobs().length, 0);
        world.explainers.set(EXPLAINER, { ...world.explainer(), status: 'failed', failed_step: 'write', error: SIGNED_OUT, job_id: null });
        assert.equal(await takeOverWrite(TENANT, EXPLAINER, NOW), null, 'a signed-out Mac stays failed, with its reason, for the owner to read');
    });

    it('is idempotent: a second look finds the work already taken, and starts nothing', async () => {
        macWriting(UNCLAIMED_MINUTES + 5);
        const first = await takeOverWrite(TENANT, EXPLAINER, NOW);
        assert.ok(first);
        assert.equal(await takeOverWrite(TENANT, EXPLAINER, NOW), null);
        assert.equal(await takeOverWrite(TENANT, EXPLAINER, NOW + 60 * 60_000), null, 'nor an hour later');
        assert.equal(geminiJobs().length, 1, 'one Gemini job');
        assert.equal(world.explainer().job_id, first!.jobId);
    });

    it('takes the explainer’s lock FIRST, in one transaction, then closes the Mac’s job, then writes Gemini’s: two looks at once take turns, and the second sees the first’s work', async () => {
        macWriting(30);
        world.db.statements.length = 0;
        await takeOverWrite(TENANT, EXPLAINER, NOW);
        const sql = world.db.statements.map((s) => s.sql);
        const at = (pattern: RegExp) => sql.findIndex((s) => pattern.test(s));
        const begin = at(/^BEGIN$/);
        const lock = at(/^SELECT \* FROM explainers WHERE id = \$1 AND creator_id = \$2 FOR UPDATE$/);
        const close = at(/^UPDATE studio_jobs SET status = 'failed'/);
        const insert = at(/^INSERT INTO studio_jobs/);
        const point = at(/^UPDATE explainers SET .*job_id = /);
        const commit = at(/^COMMIT$/);
        assert.ok(begin >= 0 && begin < lock && lock < close && close < insert && insert < point && point < commit, JSON.stringify({ begin, lock, close, insert, point, commit }));
        assert.equal(sql.filter((s) => s === 'BEGIN').length, 1, 'one transaction');
    });

    it('is atomic: Gemini’s job cannot be written, and the Mac’s job is still open and the explainer still the Mac’s', async () => {
        const mac = macWriting(30);
        world.db.routes.unshift([/^INSERT INTO studio_jobs/, () => { throw new Error('connection terminated'); }]);
        await assert.rejects(takeOverWrite(TENANT, EXPLAINER, NOW), /connection terminated/);
        assert.equal(world.jobs.find((j) => j.id === mac.id)!.status, 'pending', 'rolled back');
        assert.equal(world.explainer().job_id, mac.id);
    });
});

describe('takeOverWrite: the Mac is signed out', () => {
    const signedOut = (over: Partial<ExplainerRow> = {}) => world.addExplainer({ status: 'failed', failed_step: 'write', error: SIGNED_OUT, job_id: null, title: null, draft: null, draft_version: 0, ...over });

    it('the explainer goes from failed back to writing, as Gemini’s, and the failure is replaced by why', async () => {
        signedOut();
        const run = await takeOverWrite(TENANT, EXPLAINER, NOW);
        assert.ok(run);
        const row = world.explainer();
        assert.equal(row.status, 'writing');
        assert.equal(row.failed_step, null);
        assert.equal(row.job_id, run!.jobId);
        assert.match(row.error ?? '', /Claude on the Mac is signed out, so Gemini is writing it\. Sign in again on the Mac/);
        assert.equal(geminiJobs().length, 1);
    });

    it('not for a failure that is not a sign-in, not for another step, and not for Gemini’s own failure: no loop of takeovers', async () => {
        signedOut({ error: 'claude answered with an error: You\'ve hit your weekly limit' });
        assert.equal(await takeOverWrite(TENANT, EXPLAINER, NOW), null);
        world.explainers.clear();
        signedOut({ failed_step: 'voice', error: SIGNED_OUT });
        assert.equal(await takeOverWrite(TENANT, EXPLAINER, NOW), null);
        world.explainers.clear();
        signedOut({ error: 'Gemini refused the research call on every model it tried (HTTP 429: Quota exceeded). Google Search grounding is not offered on every Gemini key' });
        assert.equal(await takeOverWrite(TENANT, EXPLAINER, NOW), null);
        world.explainers.clear();
        signedOut({ error: null });
        assert.equal(await takeOverWrite(TENANT, EXPLAINER, NOW), null);
        assert.equal(geminiJobs().length, 0);
    });

    it('is idempotent, like the other: it is writing now, and a second look finds it so', async () => {
        signedOut();
        assert.ok(await takeOverWrite(TENANT, EXPLAINER, NOW));
        assert.equal(await takeOverWrite(TENANT, EXPLAINER, NOW), null);
        assert.equal(geminiJobs().length, 1);
    });
});

// ─── Looking: the lazy check, the failure route, the cron ──────────────────────────────────────

describe('reconcileWriting: the check that runs when the dashboard reads, after a failure, and daily', () => {
    it('starts a run after the takeover has committed, and gives back what it started', async () => {
        macWriting(30);
        let open = -1;
        setRunLauncher((work) => {
            open = world.db.statements.filter((s) => s.sql === 'BEGIN').length - world.db.statements.filter((s) => s.sql === 'COMMIT' || s.sql === 'ROLLBACK').length;
            launched.push({ run: { creatorId: TENANT, explainerId: EXPLAINER, jobId: 'x' }, work });
        });
        const run = await reconcileWriting(TENANT, EXPLAINER, NOW);
        assert.ok(run);
        assert.equal(launched.length, 1);
        assert.equal(open, 0, 'no transaction is open when Gemini is asked: a call to Google never holds a connection');
        await launched[0]!.work;
    });

    it('does nothing for an explainer that is not writing or failed at the write, and costs one read', async () => {
        world.addExplainer({ status: 'draft' });
        world.db.statements.length = 0;
        assert.equal(await reconcileWriting(TENANT, EXPLAINER, NOW), null);
        assert.equal(world.db.statements.length, 1);
        assert.equal(launched.length, 0);
    });

    it('does not start a second run for a Gemini run that is alive: it has a heartbeat', async () => {
        const mac = macWriting(30);
        const run = await reconcileWriting(TENANT, EXPLAINER, NOW);
        assert.ok(run);
        assert.equal(mac.status, 'failed');
        assert.equal(await reconcileWriting(TENANT, EXPLAINER, NOW + 60_000), null);
        assert.equal(launched.length, 1);
        await launched[0]!.work;
    });

    it('never throws into the caller: a failure to read is logged and is no run', async () => {
        macWriting(30);
        world.db.routes.unshift([/^SELECT \* FROM explainers WHERE id = \$1 AND creator_id = \$2$/, () => { throw new Error('connection terminated'); }]);
        assert.equal(await reconcileWriting(TENANT, EXPLAINER, NOW), null);
        assert.ok(logs.some((l) => l.event === 'explainer.reconcile_failed'));
    });

    it('with the fallback off, leaves a Mac job that has waited an hour exactly as it is', async () => {
        world.settingsRow = explainerSettings({ characters: [KARIM], writer_fallback: false });
        const mac = macWriting(60);
        assert.equal(await reconcileWriting(TENANT, EXPLAINER, NOW), null);
        assert.equal(mac.status, 'pending');
        assert.equal(launched.length, 0);
    });
});

describe('afterJobFailed: the worker’s failure route', () => {
    it('answers a sign-in failure at once: the explainer fails as any does, and then Gemini takes the work over', async () => {
        const job = world.addJob({ id: JOB, kind: 'explainer_write', status: 'claimed', payload: { explainer_id: EXPLAINER }, claimed_at: world.now, heartbeat_at: world.now });
        world.addExplainer({ status: 'writing', job_id: job.id, title: null, draft: null, draft_version: 0 });
        await failJob(TENANT, JOB, SIGNED_OUT);
        assert.equal(world.explainer().status, 'failed', 'the failure is recorded first, with the worker’s words');
        assert.equal(world.explainer().error, SIGNED_OUT);
        await afterJobFailed(TENANT, JOB);
        assert.equal(world.explainer().status, 'writing');
        assert.equal(geminiJobs().length, 1);
        assert.equal(launched.length, 1);
        await launched[0]!.work;
    });

    it('leaves any other failure of a write alone, and the failure of any other kind of job', async () => {
        const job = world.addJob({ id: JOB, kind: 'explainer_write', status: 'claimed', payload: { explainer_id: EXPLAINER } });
        world.addExplainer({ status: 'writing', job_id: job.id });
        await failJob(TENANT, JOB, 'claude didn\'t answer within 20 min');
        await afterJobFailed(TENANT, JOB);
        assert.equal(world.explainer().status, 'failed');
        assert.equal(launched.length, 0);
        const voice = world.addJob({ kind: 'explainer_voice', status: 'claimed', payload: { explainer_id: EXPLAINER } });
        await afterJobFailed(TENANT, voice.id);
        await afterJobFailed(TENANT, world.uuid());
        assert.equal(launched.length, 0);
    });

    it('never throws into the route', async () => {
        world.db.routes.unshift([/^SELECT id, kind, status, payload, created_at, heartbeat_at FROM studio_jobs/, () => { throw new Error('connection terminated'); }]);
        await afterJobFailed(TENANT, JOB);
        assert.ok(logs.some((l) => l.event === 'explainer.after_fail_failed'));
    });
});

describe('reapStalledRun: a Gemini run that died', () => {
    const run = (heartbeatMinutesAgo: number) => {
        const job = world.addJob({
            id: JOB, kind: 'explainer_write', status: 'claimed', payload: { explainer_id: EXPLAINER, writer: 'gemini' }, attempts: 3, claimed_at: minutesAgo(heartbeatMinutesAgo), heartbeat_at: minutesAgo(heartbeatMinutesAgo),
        });
        world.addExplainer({ status: 'writing', job_id: job.id, title: null, draft: null, draft_version: 0 });
        return job;
    };

    it('is failed once its heartbeat is stale, so the explainer says why and Retry is offered; it is not started again by itself', async () => {
        const job = run(STALLED_RUN_MINUTES + 1);
        assert.equal(await reapStalledRun(TENANT, EXPLAINER, NOW), true);
        assert.equal(job.status, 'failed');
        const row = world.explainer();
        assert.deepEqual([row.status, row.failed_step], ['failed', 'write']);
        assert.match(row.error ?? '', /Gemini did not finish writing this script \(it stopped answering\)\. Press Retry/);
        assert.equal(geminiJobs().length, 1, 'no second run: each costs two of the free tier’s few requests a day');
        assert.equal(launched.length, 0);
    });

    it('leaves a run that is alive, a Mac job that is claimed, and an explainer that is not writing', async () => {
        const job = run(STALLED_RUN_MINUTES - 1);
        assert.equal(await reapStalledRun(TENANT, EXPLAINER, NOW), false);
        assert.equal(job.status, 'claimed');
        job.payload = { explainer_id: EXPLAINER };
        job.heartbeat_at = minutesAgo(60);
        assert.equal(await reapStalledRun(TENANT, EXPLAINER, NOW), false, 'a Mac job is the worker’s to heartbeat; the queue’s own reaper handles it');
        job.payload = { explainer_id: EXPLAINER, writer: 'gemini' };
        world.explainers.set(EXPLAINER, { ...world.explainer(), status: 'draft' });
        assert.equal(await reapStalledRun(TENANT, EXPLAINER, NOW), false);
    });
});

describe('sweepWriting: the daily cron', () => {
    it('looks at every explainer that is writing or failed at the write, and takes over the ones that need it', async () => {
        macWriting(30, { id: EXPLAINER }, { id: JOB });
        const other = world.addJob({ kind: 'explainer_write', status: 'pending', payload: { explainer_id: '55555555-5555-4555-8555-555555555555' }, created_at: minutesAgo(2) });
        world.addExplainer({ id: '55555555-5555-4555-8555-555555555555', status: 'writing', job_id: other.id });
        world.addExplainer({ id: '66666666-6666-4666-8666-666666666666', status: 'failed', failed_step: 'write', error: SIGNED_OUT });
        world.addExplainer({ id: '88888888-8888-4888-8888-888888888888', status: 'draft' });
        const result = await sweepWriting(25, NOW);
        assert.deepEqual(result, { looked: 3, started: 2 });
        assert.equal(launched.length, 2);
        assert.equal(other.status, 'pending', 'two minutes old: the Mac may still come');
        await Promise.all(launched.map((l) => l.work));
    });

    it('is bounded, and one explainer that cannot be read is not the others’ failure', async () => {
        for (let i = 1; i <= 5; i++) world.addExplainer({ id: `${i}${i}${i}${i}${i}${i}${i}${i}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, status: 'writing', job_id: null });
        assert.equal((await sweepWriting(3, NOW)).looked, 3);
        world.db.routes.unshift([/^SELECT \* FROM explainers WHERE id = \$1 AND creator_id = \$2$/, () => { throw new Error('connection terminated'); }]);
        assert.deepEqual(await sweepWriting(25, NOW), { looked: 5, started: 0 });
    });
});

// ─── The run ───────────────────────────────────────────────────────────────────────────────────

describe('runGeminiWrite', () => {
    const written = (over: Partial<GeminiWritten> = {}): GeminiWritten => ({
        written: validWriterOutput(12), model: 'gemini-3.1-pro-preview',
        report: { queries: 2, sources_found: 3, sources_kept: 3, dropped_unknown_url: 0, dropped_uncited: 0, research_model: 'gemini-3.1-pro-preview', repaired: false }, ...over,
    });
    /** A writing explainer with Gemini's own claimed job, as the takeover or a create with Gemini chosen leaves them. */
    const gemini = (over: Partial<ExplainerRow> = {}) => {
        const job = world.addJob({ id: JOB, kind: 'explainer_write', status: 'claimed', attempts: 3, payload: { explainer_id: EXPLAINER, writer: 'gemini' }, claimed_at: world.now, heartbeat_at: world.now });
        world.addExplainer({ status: 'writing', job_id: job.id, title: null, draft: null, draft_version: 0, language: 'en', ...over });
        return { job, run: { creatorId: TENANT, explainerId: EXPLAINER, jobId: JOB } satisfies GeminiRun };
    };

    it('writes from the explainer’s own rows and the settings, and the draft lands as the Mac’s does, marked Gemini’s', async () => {
        const { run } = gemini({ topic: 'Why AI answers with confidence', notes: 'point to the paper', source_links: [{ url: 'https://arxiv.org/abs/2005.11401' }] });
        const asked: GeminiWriteArgs[] = [];
        await runGeminiWrite(run, { write: async (args) => { asked.push(args); await args.onProgress?.('Gemini is researching the topic on the web'); return written(); }, now: () => NOW });
        assert.equal(asked.length, 1);
        assert.deepEqual([asked[0]!.request.topic, asked[0]!.request.notes, asked[0]!.request.language, asked[0]!.request.tier], ['Why AI answers with confidence', 'point to the paper', 'en', 'short']);
        assert.deepEqual(asked[0]!.request.sourceLinks, ['https://arxiv.org/abs/2005.11401']);
        assert.deepEqual(asked[0]!.request.characters, [{ key: 'karim', name: 'Karim', description: 'a curious young man' }]);
        assert.equal(asked[0]!.request.today, '2026-10-25');
        assert.equal(asked[0]!.pace, 2.5, 'the settings’ pace for the language');
        assert.equal(asked[0]!.request.rewriteNote, undefined);

        const row = world.explainer();
        assert.equal(row.status, 'draft');
        assert.equal(row.draft!.writer, 'gemini');
        assert.equal(row.draft_version, 1);
        assert.equal(world.sceneRows().length, 12);
        assert.ok(!row.draft!.warnings.some((w) => w.code === 'research_limited'), 'grounding gives its sources: no research_rounds, no flag');
        assert.equal(world.jobs[0]!.status, 'done');
        assert.equal((world.jobs[0]!.result as { model: string }).model, 'gemini-3.1-pro-preview');
    });

    it('says what it is doing as it goes: the job’s progress line, and its heartbeat', async () => {
        const { run } = gemini();
        const said: string[] = [];
        await runGeminiWrite(run, {
            write: async (args) => { await args.onProgress?.('Gemini is researching the topic on the web'); said.push(world.jobs[0]!.progress ?? ''); return written(); }, now: () => NOW,
        });
        assert.deepEqual(said, ['Gemini is researching the topic on the web']);
    });

    it('a rewrite carries the owner’s request and the draft it is about', async () => {
        const { run } = gemini({ status: 'writing', rewrite_note: 'shorter hook', draft: validDraft(), title: 'Old title', draft_version: 1 });
        world.addScenes(12);
        const asked: GeminiWriteArgs[] = [];
        await runGeminiWrite(run, { write: async (args) => { asked.push(args); return written(); }, now: () => NOW });
        assert.equal(asked[0]!.request.rewriteNote, 'shorter hook');
        assert.equal(asked[0]!.request.previousDraft!.scenes.length, 12);
        assert.equal(asked[0]!.request.previousDraft!.title, 'Old title');
    });

    it('a failure is the job’s failure: the explainer goes failed at the write with the reason, and the run does not reject', async () => {
        const { run } = gemini();
        await runGeminiWrite(run, { write: async () => { throw new GeminiWriteError('Gemini refused the research call on every model it tried (HTTP 429: Quota exceeded).', 'research'); }, now: () => NOW });
        const row = world.explainer();
        assert.deepEqual([row.status, row.failed_step], ['failed', 'write']);
        assert.match(row.error ?? '', /Gemini refused the research call on every model it tried \(HTTP 429: Quota exceeded\)\./);
        assert.equal(world.jobs[0]!.status, 'failed');
        assert.equal(launched.length, 0);
        assert.equal(await takeOverWrite(TENANT, EXPLAINER, NOW), null, 'and Gemini’s own failure is not taken over again');
    });

    it('does nothing when the job is no longer the explainer’s (it was superseded, rewritten or deleted) and does not even ask Gemini', async () => {
        const { run } = gemini();
        world.explainers.set(EXPLAINER, { ...world.explainer(), job_id: world.uuid() });
        let asked = 0;
        const deps = { write: async () => { asked++; return written(); }, now: () => NOW };
        await runGeminiWrite(run, deps);
        world.explainers.clear();
        await runGeminiWrite(run, deps);
        world.addExplainer({ status: 'draft', job_id: JOB });
        await runGeminiWrite(run, deps);
        assert.equal(asked, 0);
        assert.equal(world.jobs[0]!.status, 'claimed');
        assert.equal(logs.filter((l) => l.event === 'explainer.gemini_run_skipped').length, 3);
    });

    it('never rejects, even when the draft cannot be stored: the stalled-run check finds the job later', async () => {
        const { run } = gemini();
        world.db.routes.unshift([/^UPDATE explainers SET status = \$2/, () => { throw new Error('connection terminated'); }]);
        await runGeminiWrite(run, { write: async () => written(), now: () => NOW });
        assert.ok(logs.some((l) => l.event === 'explainer.gemini_run_error'));
        assert.equal(world.explainer().status, 'writing');
    });

    it('holds no transaction open while it asks Gemini', async () => {
        const { run } = gemini();
        let open = -1;
        await runGeminiWrite(run, {
            write: async () => {
                open = world.db.statements.filter((s) => s.sql === 'BEGIN').length - world.db.statements.filter((s) => s.sql === 'COMMIT' || s.sql === 'ROLLBACK').length;
                return written();
            }, now: () => NOW,
        });
        assert.equal(open, 0);
    });

    it('is what completeJob applies for a job whose payload says Gemini: the same door as the Mac’s, and an answer for an older job is dropped there', async () => {
        const { job } = gemini();
        world.explainers.set(EXPLAINER, { ...world.explainer(), job_id: world.uuid() });
        assert.equal(await completeJob(TENANT, job.id, { written: validWriterOutput(12), model: 'm' }), 'dropped');
    });
});

describe('startGeminiRun: kept alive past the response', () => {
    it('hands the platform a run that is already going, never one that has not started (waitUntil runs nothing itself)', async () => {
        setRunLauncher(null);
        const handed: Promise<unknown>[] = [];
        const previous = setWaitUntil((work) => { handed.push(work); });
        try {
            let started = false;
            setRunDeps({ write: async () => { started = true; throw new GeminiWriteError('stop', 'research'); } });
            const job = world.addJob({ id: JOB, kind: 'explainer_write', status: 'claimed', payload: { explainer_id: EXPLAINER, writer: 'gemini' }, heartbeat_at: world.now });
            world.addExplainer({ status: 'writing', job_id: job.id });
            startGeminiRun({ creatorId: TENANT, explainerId: EXPLAINER, jobId: job.id });
            assert.equal(handed.length, 1);
            await handed[0];
            assert.equal(started, true);
        } finally {
            setWaitUntil(previous);
        }
    });
});

function validDraft() {
    const out = validWriterOutput(12);
    return { writer: 'claude_mac' as const, captions: out.captions, first_comment: out.first_comment, replies: out.replies, sources: out.sources, est_seconds: 70, warnings: [] };
}
