/**
 * Tests only: a job queue in memory, with the semantics the SQL in `queue.ts` gives `complete` and `fail`, so a test can run real handlers
 * through the real `drainJobs` and then look at what the table would hold. Nothing here is imported by production code.
 *
 *   - `claim` takes `pending` jobs, makes them `running` and counts the attempt, as the claim does (the handler is handed a COPY of the payload:
 *     what it holds in memory is not what is stored)
 *   - `complete(id, redact)` ends the job `done`; with `redact`, the stored payload is replaced in that same step
 *   - `fail(id, error, retryIn, redact)` returns the job to `pending` for a retry, or ends it `failed`; only an ending failure with `redact`
 *     replaces the payload
 *   - `releaseUnrun(ids)` returns the jobs among them that are still `running` to `pending` and gives back the attempt the claim counted
 *     (never below 0); a job in any other state is left as it is
 *
 * `run_after` is not modelled: a job waiting out its backoff is claimable at once, which is what a test stepping through attempts wants.
 */
import type { EnqueueInput, Job, JobKind, JobQueue } from './types.js';

export interface MemoryJob extends Job {
    status: 'pending' | 'running' | 'done' | 'failed';
    last_error: string | null;
}

export function memoryQueue(planned: EnqueueInput[], maxAttempts = 3): { jobs: MemoryJob[]; queue: JobQueue; completed: Array<{ id: string; redacted: boolean }> } {
    const jobs: MemoryJob[] = planned.map((p, i) => ({
        id: `job-${i + 1}`,
        kind: p.kind as JobKind,
        payload: JSON.parse(JSON.stringify(p.payload)),
        attempts: 0,
        max_attempts: maxAttempts,
        request_id: null,
        creator_id: null,
        tenant_key: p.tenantKey ?? null,
        status: 'pending',
        last_error: null,
    }));
    const completed: Array<{ id: string; redacted: boolean }> = [];
    const find = (id: string) => {
        const job = jobs.find((j) => j.id === id);
        if (!job) throw new Error(`no job ${id}`);
        return job;
    };
    const queue: JobQueue = {
        async enqueue() { return null; },
        async claim(limit) {
            const picked = jobs.filter((j) => j.status === 'pending').slice(0, limit);
            for (const job of picked) { job.status = 'running'; job.attempts += 1; }
            return picked.map((j) => ({ ...j, payload: JSON.parse(JSON.stringify(j.payload)) }) as Job);
        },
        async complete(id, redact) {
            const job = find(id);
            job.status = 'done';
            job.last_error = null;
            if (redact) job.payload = JSON.parse(JSON.stringify(redact.payload));
            completed.push({ id, redacted: Boolean(redact) });
        },
        async fail(id, error, retryInSeconds, redact) {
            const job = find(id);
            job.last_error = error;
            if (retryInSeconds === null) {
                job.status = 'failed';
                if (redact) job.payload = JSON.parse(JSON.stringify(redact.payload));
            } else {
                job.status = 'pending';
            }
        },
        async reapStale() { return 0; },
        async releaseUnrun(ids) {
            let released = 0;
            for (const id of ids) {
                const job = jobs.find((j) => j.id === id);
                if (!job || job.status !== 'running') continue;
                job.status = 'pending';
                job.attempts = Math.max(job.attempts - 1, 0);
                released += 1;
            }
            return released;
        },
        async pruneCompleted() { return 0; },
    };
    return { jobs, queue, completed };
}
