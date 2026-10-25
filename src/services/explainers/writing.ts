/**
 * Who writes an explainer's script, and how it is started: Claude on the owner's Mac, by default, or Gemini on the server (writerGemini.ts), which steps in
 * in three cases and no others (FR-002; the owner, 2026-10-25: "for the ai use our Claude or Gemini for now"):
 *
 *   a. the owner chose Gemini in Settings (`explainer.writer = 'gemini'`): the job is Gemini's from the start and the Mac is never asked;
 *   b. the Mac's write fails with a sign-in error ("Failed to authenticate: OAuth session expired…"): the explainer goes `failed`, as any failure does, and the
 *      next look at it (the route that took the failure, the dashboard reading it, the daily cron) takes the work over;
 *   c. the Mac has not picked the job up in ten minutes (it is off, or asleep): the same look takes the work over and closes the Mac's job, so it can never be
 *      claimed later and a late answer from it would be dropped (only the result of `explainers.job_id` is applied).
 *
 * `writer_fallback = false` means never: the explainer waits for the Mac, or fails with its reason, and Gemini is only used when the owner chose it.
 *
 * The takeover is one transaction with the explainer's row locked: it closes the Mac's job, writes Gemini's own job (kind `explainer_write`, `claimed` by the
 * server, `writer: 'gemini'` in its payload, three attempts spent so the Mac's claim never takes it back) and points `explainers.job_id` at it. Two lookups at
 * once take turns on the lock, and the second finds the work already taken. The Gemini run is started AFTER the transaction commits (no call to Google is made
 * inside one), under `waitUntil`, and ends the way the Mac's job does: `completeJob` with the draft, or `failJob` with the reason. A run that dies leaves a
 * claimed job whose heartbeat goes stale; the next look fails it (`reapStalledRun`), so the explainer shows why and the owner presses Retry. It never starts a
 * second run by itself: each run spends two of the free tier's few requests a day.
 */
import type { ExplainerRow, ExplainerWritePayload } from '../../db/rows.js';
import { describeError, log } from '../../utils/log.js';
import { waitUntil } from '../../utils/waitUntil.js';
import { pool } from '../../config/db.js';
import { type Exec, isPlainObject, withTransaction } from '../studio/common.js';
import { completeJob, enqueueJob, failJob, MAX_ATTEMPTS, reportProgress } from '../studio/jobs.js';
import { getStudioSettings } from '../studio/settings.js';
import type { StudioSettings } from '../studio/settingsTypes.js';
import { previousDraftOf, writePayload, writerRequest } from './payloads.js';
import { transitionExplainer } from './state.js';
import { loadScenes, lockExplainer, readExplainer, updateExplainerFields } from './store.js';
import { type GeminiWriteArgs, type GeminiWritten, writeWithGemini } from './writerGemini.js';

/** How long the Mac's write job may sit unclaimed before Gemini takes the work over. */
export const UNCLAIMED_MINUTES = 10;
/** How long a Gemini run may go without a heartbeat before it is taken for dead (a run is two calls of under two minutes each). */
export const STALLED_RUN_MINUTES = 5;

// ─── The Mac's sign-in failure ─────────────────────────────────────────────────────────────────

/**
 * What the Claude CLI says when it is signed out, as the worker reports it: `claude answered with an error: Failed to authenticate: OAuth session expired and
 * could not be refreshed` (the worker's log, 2026-10-01 and 2026-10-22), and the older and shorter forms of the same refusal. Conservative on purpose: each
 * phrase is a whole sign-in message, and a bare "OAuth" or "401" is not one (a draft about OAuth, a failed page, a rate limit and a spent weekly allowance are
 * failures of their own, and the owner is told what they are instead of being sent to Gemini).
 */
const SIGN_IN_FAILURES: readonly RegExp[] = [
    /failed to authenticate/i,
    /oauth (?:session|token) (?:has )?expired/i,
    /\bnot logged in\b/i,
    /please run \/login/i,
    /invalid api key\s*[·\-–—]\s*please run/i,
    /\bauthentication_error\b/i,
];

export function isSignInFailure(message: string | null | undefined): boolean {
    return typeof message === 'string' && SIGN_IN_FAILURES.some((pattern) => pattern.test(message));
}

// ─── Queueing a write ──────────────────────────────────────────────────────────────────────────

export type Writer = 'claude_mac' | 'gemini';

/**
 * Gemini's own `explainer_write` job: written already `claimed`, by the server, with the attempts used up. `claimJob`'s statement takes a `claimed` job only
 * when its heartbeat is stale and it has fewer than three attempts, so with all three spent the Mac never takes a Gemini run back. The payload is slim: the
 * run reads the explainer and the settings itself when it starts, and the prompts the Mac would have been sent are of no use to it.
 */
export async function insertServerWriteJob(exec: Exec, creatorId: string, row: Pick<ExplainerRow, 'id' | 'language' | 'length_tier' | 'topic'>): Promise<{ id: string }> {
    const payload = { explainer_id: row.id, language: row.language, length_tier: row.length_tier, topic: row.topic, writer: 'gemini' };
    const { rows } = await exec.query<{ id: string }>(
        `INSERT INTO studio_jobs (creator_id, kind, payload, status, attempts, claimed_at, heartbeat_at, progress)
         VALUES ($1, 'explainer_write', $2::jsonb, 'claimed', $3, NOW(), NOW(), 'Gemini is writing it')
         RETURNING id`,
        [creatorId, JSON.stringify(payload), MAX_ATTEMPTS]
    );
    if (!rows[0]) throw new Error('studio_jobs insert returned no row.');
    return rows[0];
}

export interface QueuedWrite {
    jobId: string;
    writer: Writer;
}

/**
 * Queue the script's writing for an explainer whose row the caller holds locked: Claude's job for the Mac, or Gemini's own. `rewrite` is the owner's request
 * and the draft it is about. The caller points `explainers.job_id` at `jobId` (create does it with the insert, rewrite and retry with their transition) and,
 * when `writer` is `gemini`, starts the run after the transaction commits (`startGeminiRun`).
 */
export async function queueWrite(
    exec: Exec, row: ExplainerRow, settings: StudioSettings, opts: { today: string; rewrite?: { note: string; previous: ReturnType<typeof previousDraftOf> } | null; writer?: Writer }
): Promise<QueuedWrite> {
    const writer = opts.writer ?? settings.explainer.writer;
    if (writer === 'gemini') return { jobId: (await insertServerWriteJob(exec, row.creator_id, row)).id, writer };
    const payload: ExplainerWritePayload = writePayload({ row, settings, today: opts.today, rewrite: opts.rewrite ?? null });
    return { jobId: (await enqueueJob(exec, row.creator_id, 'explainer_write', payload)).id, writer };
}

// ─── Running Gemini ────────────────────────────────────────────────────────────────────────────

export interface GeminiRun {
    creatorId: string;
    explainerId: string;
    jobId: string;
}

/** What the run uses beyond the database, so a test can replace each: Gemini, and the three ends of a job. */
export interface RunDeps {
    write?: (args: GeminiWriteArgs) => Promise<GeminiWritten>;
    complete?: typeof completeJob;
    fail?: typeof failJob;
    progress?: typeof reportProgress;
    now?: () => number;
}

const todayOf = (now: number): string => new Date(now).toISOString().slice(0, 10);

const failureText = (err: unknown): string => {
    const text = err instanceof Error ? err.message : String(err);
    return text.replace(/\s+/g, ' ').slice(0, 1800) || 'Gemini failed without saying why.';
};

/**
 * One Gemini write, from the explainer's own rows to its draft. Never rejects: whatever goes wrong is the job's failure (`failJob`, which fails the explainer at
 * the write step with the reason) and, if even that cannot be recorded, a log line. Nothing is held open across the model calls: the rows are read, the
 * transaction closed, Gemini asked, and only then does `completeJob` open one.
 */
export async function runGeminiWrite(run: GeminiRun, deps: RunDeps = {}): Promise<void> {
    const now = deps.now ?? Date.now;
    const complete = deps.complete ?? completeJob;
    const fail = deps.fail ?? failJob;
    const progress = deps.progress ?? reportProgress;
    const tell = async (text: string): Promise<void> => {
        // The heartbeat is the run's proof of life, and its progress line is what the dashboard shows. A job that is no longer claimed refuses it: stop caring.
        await progress(run.creatorId, run.jobId, text).catch(() => undefined);
    };
    try {
        const row = await readExplainer(pool, run.creatorId, run.explainerId);
        if (!row || row.job_id !== run.jobId || row.status !== 'writing') {
            log('info', 'explainer.gemini_run_skipped', { explainer_id: run.explainerId, job_id: run.jobId, reason: !row ? 'gone' : row.job_id !== run.jobId ? 'superseded' : `not_writing:${row.status}` });
            return;
        }
        const [settings, scenes] = await Promise.all([getStudioSettings(run.creatorId), loadScenes(pool, run.creatorId, run.explainerId)]);
        const rewrite = row.rewrite_note && row.draft ? { note: row.rewrite_note, previous: previousDraftOf(row, scenes) } : null;
        const request = writerRequest({ row, settings, today: todayOf(now()), rewrite });
        log('info', 'explainer.gemini_run_started', { explainer_id: row.id, job_id: run.jobId, language: row.language, tier: row.length_tier, rewrite: Boolean(rewrite) });

        let written: GeminiWritten;
        try {
            written = await (deps.write ?? writeWithGemini)({ request, pace: settings.explainer.pace[row.language], now: deps.now, onProgress: tell });
        } catch (err) {
            log('warn', 'explainer.gemini_run_failed', { explainer_id: row.id, job_id: run.jobId, ...describeError(err) });
            await fail(run.creatorId, run.jobId, failureText(err));
            return;
        }
        const outcome = await complete(run.creatorId, run.jobId, { written: written.written, model: written.model });
        log('info', 'explainer.gemini_run_done', { explainer_id: row.id, job_id: run.jobId, outcome, model: written.model, ...written.report });
    } catch (err) {
        // Not Gemini's failure: the rows could not be read, or the job could not be completed or failed. The stalled-run check will find the job.
        log('error', 'explainer.gemini_run_error', { explainer_id: run.explainerId, job_id: run.jobId, ...describeError(err) });
    }
}

/** Starts a run so that it outlives the response that asked for it: handed to the platform's `waitUntil`, and replaced by the tests. */
export type RunLauncher = (work: Promise<void>) => void;
let launcher: RunLauncher = (work) => waitUntil(work);

/** Swap how a run is kept alive (tests). Returns the previous one. */
export function setRunLauncher(next: RunLauncher | null): RunLauncher {
    const previous = launcher;
    launcher = next ?? ((work) => waitUntil(work));
    return previous;
}

let runDeps: RunDeps = {};
/** Swap what a run uses beyond the database (tests). Returns the previous one. */
export function setRunDeps(next: RunDeps | null): RunDeps {
    const previous = runDeps;
    runDeps = next ?? {};
    return previous;
}

/** Start a Gemini run after the transaction that wrote its job has committed. The run is already going when the platform is told to wait for it. */
export function startGeminiRun(run: GeminiRun): void {
    launcher(runGeminiWrite(run, runDeps));
}

// ─── The takeover ──────────────────────────────────────────────────────────────────────────────

interface JobLook {
    id: string;
    kind: string;
    status: string;
    payload: unknown;
    created_at: Date | string;
    heartbeat_at: Date | string | null;
}

async function lookAtJob(exec: Exec, creatorId: string, jobId: string): Promise<JobLook | null> {
    const { rows } = await exec.query<JobLook>(
        'SELECT id, kind, status, payload, created_at, heartbeat_at FROM studio_jobs WHERE id = $1 AND creator_id = $2', [jobId, creatorId]
    );
    return rows[0] ?? null;
}

const minutesSince = (when: Date | string | null, now: number): number => (when === null ? Number.POSITIVE_INFINITY : (now - new Date(when).getTime()) / 60_000);
const isGeminiJob = (job: Pick<JobLook, 'payload'>): boolean => isPlainObject(job.payload) && job.payload.writer === 'gemini';

/** Why Gemini may take this explainer's writing over, or null: the three cases of the top of the file that are takeovers (the first is not one). */
async function takeoverReason(exec: Exec, row: ExplainerRow, now: number): Promise<{ why: 'unclaimed' | 'signed_out'; macJobId: string | null; note: string } | null> {
    if (row.status === 'writing' && row.job_id) {
        const job = await lookAtJob(exec, row.creator_id, row.job_id);
        if (job && job.kind === 'explainer_write' && job.status === 'pending' && !isGeminiJob(job) && minutesSince(job.created_at, now) >= UNCLAIMED_MINUTES) {
            return { why: 'unclaimed', macJobId: job.id, note: `The Mac did not pick this up in ${UNCLAIMED_MINUTES} minutes, so Gemini is writing it.` };
        }
        return null;
    }
    if (row.status === 'failed' && row.failed_step === 'write' && isSignInFailure(row.error)) {
        return { why: 'signed_out', macJobId: null, note: 'Claude on the Mac is signed out, so Gemini is writing it. Sign in again on the Mac to have Claude write.' };
    }
    return null;
}

/**
 * Take an explainer's writing over for Gemini, if it is the case for it, and say which run to start (the caller starts it, after this has committed). Null when
 * the owner turned the fallback off, when the explainer is not in a state that allows it, or when another look got there first: the row is locked, and what is
 * decided is decided on the locked row, so two looks at once start one run.
 */
export async function takeOverWrite(creatorId: string, explainerId: string, now: number = Date.now()): Promise<GeminiRun | null> {
    // Read before the transaction: the pool is small, and a settings read inside one is a second connection's worth of waiting.
    const settings = await getStudioSettings(creatorId);
    if (!settings.explainer.writer_fallback) return null;
    return withTransaction(async (client) => {
        const row = await lockExplainer(client, creatorId, explainerId);
        if (!row) return null;
        const reason = await takeoverReason(client, row, now);
        if (!reason) return null;
        if (reason.macJobId) {
            // Closed, so the Mac can never claim it later; a Mac that already holds it is not "unclaimed", and is not taken over.
            await client.query(
                `UPDATE studio_jobs SET status = 'failed', error = $3, progress = NULL, updated_at = NOW() WHERE id = $1 AND creator_id = $2 AND status = 'pending'`,
                [reason.macJobId, creatorId, reason.note]
            );
        }
        const job = await insertServerWriteJob(client, creatorId, row);
        // The note says why Gemini is writing, while it does; moving on to `draft` clears it.
        if (row.status === 'failed') await transitionExplainer(client, row.id, ['failed'], 'writing', { job_id: job.id, error: reason.note }, creatorId);
        else await updateExplainerFields(client, creatorId, row.id, { job_id: job.id, error: reason.note });
        log('info', 'explainer.write_taken_over', { explainer_id: row.id, why: reason.why, job_id: job.id, closed_job_id: reason.macJobId });
        return { creatorId, explainerId, jobId: job.id };
    });
}

/**
 * A Gemini run whose heartbeat went stale is dead (the function was killed, or never started): its job is failed, so the explainer shows why and Retry is
 * offered. Not run again by itself.
 */
export async function reapStalledRun(creatorId: string, explainerId: string, now: number = Date.now()): Promise<boolean> {
    const row = await readExplainer(pool, creatorId, explainerId);
    if (!row || row.status !== 'writing' || !row.job_id) return false;
    const job = await lookAtJob(pool, creatorId, row.job_id);
    if (!job || job.kind !== 'explainer_write' || job.status !== 'claimed' || !isGeminiJob(job) || minutesSince(job.heartbeat_at, now) < STALLED_RUN_MINUTES) return false;
    log('warn', 'explainer.gemini_run_stalled', { explainer_id: row.id, job_id: job.id });
    await failJob(creatorId, job.id, 'Gemini did not finish writing this script (it stopped answering). Press Retry to try again.');
    return true;
}

/**
 * The lazy check: is this explainer's writing stuck in a way Gemini can fix? A dead Gemini run is failed; a Mac that is signed out or has not picked the job up is
 * replaced by Gemini, unless the owner turned that off. Called when the dashboard reads the explainer, by the route that took a write's failure, and by the daily
 * cron. Cheap when there is nothing to do: one read of the row, and the job it names only while it is writing. Never throws into its caller.
 */
export async function reconcileWriting(creatorId: string, explainerId: string, now: number = Date.now()): Promise<GeminiRun | null> {
    try {
        const row = await readExplainer(pool, creatorId, explainerId);
        if (!row) return null;
        const writing = row.status === 'writing';
        const signedOut = row.status === 'failed' && row.failed_step === 'write' && isSignInFailure(row.error);
        if (!writing && !signedOut) return null;
        if (writing) await reapStalledRun(creatorId, explainerId, now);
        const run = await takeOverWrite(creatorId, explainerId, now);
        if (run) startGeminiRun(run);
        return run;
    } catch (err) {
        log('error', 'explainer.reconcile_failed', { explainer_id: explainerId, ...describeError(err) });
        return null;
    }
}

/** After a worker reported a failure (`POST /worker/jobs/:id/fail`): if it was an explainer's write, look at it now, so a sign-in failure is answered at once. */
export async function afterJobFailed(creatorId: string, jobId: string): Promise<void> {
    try {
        const job = await lookAtJob(pool, creatorId, jobId);
        if (!job || job.kind !== 'explainer_write' || !isPlainObject(job.payload) || typeof job.payload.explainer_id !== 'string') return;
        await reconcileWriting(creatorId, job.payload.explainer_id);
    } catch (err) {
        log('error', 'explainer.after_fail_failed', { job_id: jobId, ...describeError(err) });
    }
}

/**
 * The daily cron's look at every explainer that is writing or failed at the write: the backstop for the lazy check, for a dashboard nobody opens. Bounded, and a
 * failure on one explainer is not another's.
 */
export async function sweepWriting(limit = 25, now: number = Date.now()): Promise<{ looked: number; started: number }> {
    const { rows } = await pool.query<{ id: string; creator_id: string }>(
        `SELECT id, creator_id FROM explainers WHERE status = 'writing' OR (status = 'failed' AND failed_step = 'write') ORDER BY updated_at LIMIT $1`, [limit]
    );
    let started = 0;
    for (const row of rows) if (await reconcileWriting(row.creator_id, row.id, now)) started++;
    return { looked: rows.length, started };
}
