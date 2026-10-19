/**
 * The hook that lets a handler have its job's stored payload replaced as the job ends (`JobResult.redactPayload`, `redactOnFailure`).
 *
 * Three layers, each pinned where it lives:
 *   - the runner: a handler that returns nothing completes exactly as it always did (one argument, no payload), a result with a redaction is
 *     passed through, and a tagged failure redacts ONLY when it is the failure that ends the job (a retry keeps the payload the next attempt needs)
 *   - the queue: the statements. Without a redaction they are the statements they always were; with one, the payload is written in the same
 *     UPDATE that ends the job, and a failure that schedules a retry never writes it
 *   - the tag: it lives beside the error, not on it
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import { PostgresJobQueue } from './queue.js';
import { failureRedaction, redactOnFailure } from './redaction.js';
import { drainJobs } from './runner.js';
import type { Job, JobHandlerRegistry, JobKind, JobQueue, JobResult, PayloadRedaction } from './types.js';

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

// ─── The tag ────────────────────────────────────────────────────────────────────────────

describe('redactOnFailure', () => {
    it('tags the very error it is given and changes nothing else about it', () => {
        const original = Object.assign(new Error('deadlock detected'), { code: '40P01' });
        const returned = redactOnFailure(original, { redacted: true });
        assert.equal(returned, original, 'the same object: its message, name, code and stack are untouched');
        assert.deepEqual(Object.keys(original), ['code'], 'no new property on the error');
        assert.deepEqual(failureRedaction(original), { payload: { redacted: true } });
    });

    it('wraps a thrown value that is not an Error, which has nowhere to carry a tag', () => {
        const returned = redactOnFailure('just a string', { redacted: true });
        assert.ok(returned instanceof Error);
        assert.equal(returned.message, 'just a string');
        assert.deepEqual(failureRedaction(returned), { payload: { redacted: true } });
    });

    it('reads nothing off an error nobody tagged, or off something that is not an object', () => {
        assert.equal(failureRedaction(new Error('x')), null);
        for (const v of [undefined, null, 'x', 5, {}]) assert.equal(failureRedaction(v), null);
    });
});

// ─── The runner ─────────────────────────────────────────────────────────────────────────

interface Calls {
    completed: Array<{ args: unknown[] }>;
    failed: Array<{ args: unknown[] }>;
}

/** A queue that records exactly the arguments each call was made with. */
function recordingQueue(batch: Job[]): JobQueue & Calls {
    const calls: Calls = { completed: [], failed: [] };
    let served = false;
    return Object.assign(calls, {
        async enqueue() { return null; },
        async claim() { if (served) return []; served = true; return batch; },
        async complete(...args: unknown[]) { calls.completed.push({ args }); },
        async fail(...args: unknown[]) { calls.failed.push({ args }); },
        async reapStale() { return 0; },
        async pruneCompleted() { return 0; },
    }) as unknown as JobQueue & Calls;
}

const job = (over: Partial<Job> = {}): Job => ({
    id: 'job-1', kind: 'dm.process' as JobKind, payload: { secret: 'words' } as unknown as Job['payload'], attempts: 1, max_attempts: 3,
    request_id: null, creator_id: null, tenant_key: null, ...over,
}) as Job;

const registry = (handler: (job: Job) => Promise<void | JobResult>): JobHandlerRegistry =>
    ({ 'dm.process': async (_payload: unknown, j: Job) => handler(j) }) as unknown as JobHandlerRegistry;

const drain = (queue: JobQueue, handlers: JobHandlerRegistry) => drainJobs({ queue, handlers, budgetMs: 10_000, random: () => 0.5 });

describe('the runner and a handler’s result', () => {
    it('completes a handler that returns nothing with ONE argument: the call every other handler gets', async () => {
        const queue = recordingQueue([job()]);
        await drain(queue, registry(async () => {}));
        assert.deepEqual(queue.completed, [{ args: ['job-1'] }]);
    });

    it('completes a handler that returns a result with no redaction the same way', async () => {
        const queue = recordingQueue([job()]);
        await drain(queue, registry(async () => ({})));
        assert.deepEqual(queue.completed, [{ args: ['job-1'] }]);
    });

    it('hands a redaction to the same call that completes the job', async () => {
        const queue = recordingQueue([job()]);
        await drain(queue, registry(async () => ({ redactPayload: { redacted: true } })));
        assert.deepEqual(queue.completed, [{ args: ['job-1', { payload: { redacted: true } }] }]);
        assert.equal(queue.failed.length, 0);
    });

    it('does not redact a failure that will be retried: the next attempt needs the payload', async () => {
        for (const attempts of [1, 2]) {
            const queue = recordingQueue([job({ attempts })]);
            await drain(queue, registry(async () => { throw redactOnFailure(new Error('disk full'), { redacted: true }); }));
            assert.equal(queue.failed.length, 1);
            assert.equal(queue.failed[0]!.args.length, 3, `attempt ${attempts} of 3: no redaction argument`);
            assert.equal(typeof queue.failed[0]!.args[2], 'number', 'a retry is scheduled');
            assert.equal(queue.completed.length, 0);
        }
    });

    it('redacts the failure that ENDS the job, in the same call that fails it', async () => {
        const queue = recordingQueue([job({ attempts: 3 })]);
        await drain(queue, registry(async () => { throw redactOnFailure(new Error('disk full'), { redacted: true }); }));
        assert.deepEqual(queue.failed, [{ args: ['job-1', 'disk full', null, { payload: { redacted: true } }] }]);
    });

    it('leaves the payload of an ending failure alone when the handler asked for nothing', async () => {
        const queue = recordingQueue([job({ attempts: 3 })]);
        await drain(queue, registry(async () => { throw new Error('disk full'); }));
        assert.deepEqual(queue.failed, [{ args: ['job-1', 'disk full', null] }]);
    });

    it('records the error’s own message, whatever was tagged onto it', async () => {
        const queue = recordingQueue([job({ attempts: 3 })]);
        await drain(queue, registry(async () => { throw redactOnFailure(Object.assign(new Error('relation does not exist'), { code: '42P01' }), { redacted: true }); }));
        assert.equal(queue.failed[0]!.args[1], 'relation does not exist');
    });
});

// ─── The queue's statements ─────────────────────────────────────────────────────────────

interface Executed { sql: string; params: any[] }

async function withDb<T>(body: (log: Executed[]) => Promise<T>): Promise<T> {
    const executed: Executed[] = [];
    const original = pool.query;
    (pool as any).query = async (sql: string, params: any[] = []) => { executed.push({ sql, params }); return { rows: [], rowCount: 1 }; };
    try { return await body(executed); } finally { (pool as any).query = original; }
}

const flat = (sql: string) => sql.replace(/\s+/g, ' ');
const queue = new PostgresJobQueue();
const REDACT: PayloadRedaction = { payload: { object: 'whatsapp', change: { redacted: true } } };

describe('the queue’s complete and fail', () => {
    it('complete without a redaction is the statement it always was', async () => {
        await withDb(async (log) => {
            await queue.complete('job-1');
            assert.equal(flat(log[0]!.sql), "UPDATE jobs SET status = 'done', last_error = NULL, updated_at = NOW() WHERE id = $1");
            assert.deepEqual(log[0]!.params, ['job-1']);
        });
    });

    it('complete with a redaction replaces the payload in the SAME statement that ends the job', async () => {
        await withDb(async (log) => {
            await queue.complete('job-1', REDACT);
            assert.equal(log.length, 1, 'one statement: there is no moment at which the job is done and still holds the payload');
            assert.equal(flat(log[0]!.sql), "UPDATE jobs SET status = 'done', last_error = NULL, payload = $2::jsonb, updated_at = NOW() WHERE id = $1");
            assert.deepEqual(log[0]!.params, ['job-1', JSON.stringify(REDACT.payload)]);
        });
    });

    it('a terminal failure without a redaction is the statement it always was', async () => {
        await withDb(async (log) => {
            await queue.fail('job-1', 'dead token', null);
            assert.equal(flat(log[0]!.sql), "UPDATE jobs SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1");
            assert.deepEqual(log[0]!.params, ['job-1', 'dead token']);
        });
    });

    it('a terminal failure with a redaction replaces the payload in the same statement', async () => {
        await withDb(async (log) => {
            await queue.fail('job-1', 'x'.repeat(5000), null, REDACT);
            assert.equal(log.length, 1);
            assert.match(flat(log[0]!.sql), /SET status = 'failed', last_error = \$2, payload = \$3::jsonb, updated_at = NOW\(\) WHERE id = \$1/);
            assert.equal(log[0]!.params[1].length, 2000, 'the error is still bounded');
            assert.equal(log[0]!.params[2], JSON.stringify(REDACT.payload));
        });
    });

    it('a failure that schedules a retry NEVER writes the payload, even if one is offered', async () => {
        await withDb(async (log) => {
            await queue.fail('job-1', 'Gemini 503', 120, REDACT);
            assert.match(flat(log[0]!.sql), /SET status = 'pending'/);
            assert.ok(!/payload/.test(log[0]!.sql), 'the retry needs the payload as it was');
            assert.deepEqual(log[0]!.params, ['job-1', 'Gemini 503', 120]);
        });
    });
});
