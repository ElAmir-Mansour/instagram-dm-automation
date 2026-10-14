/**
 * Acknowledge, then drain under `waitUntil` (src/webhook/ack.ts).
 *
 * The bug this pins: `POST /webhook` sent 200 and then awaited the drain in the same handler. On
 * Vercel the invocation can be frozen as soon as the response is out, so an inline-claimed job sat
 * `running` until the instance thawed (about 70 s: dm.process p50 was 125 s) or the stale-claim
 * reaper took it back (about 6 min). The fix hands the drain to `waitUntil` and does not await it.
 *
 * What has to hold, and where it is checked here:
 *   - the 200 reaches the client while the work is still running (over real HTTP, then with the
 *     real `drainInline()` held at its first await)
 *   - `waitUntil` is handed the promise that runs the work: the line a mutation removes
 *   - a rejection never escapes (no unhandled rejection) and is logged as `webhook.pipeline_error`
 *   - with no Vercel context, as in dev and in tests, the work still runs
 *   - `index.ts` really routes through it
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { waitUntil as platformWaitUntil } from '@vercel/functions';
import express from 'express';
import type { Response as ExpressResponse } from 'express';
import { drainInline } from '../jobs/drain.js';
import { setJobQueue } from '../jobs/queue.js';
import type { JobQueue } from '../jobs/types.js';
import { setLogSink } from '../utils/log.js';
import { setWaitUntil } from '../utils/waitUntil.js';
import { acknowledgeThenRun } from './ack.js';

const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
}

/** A response that only records its status, for the cases that do not need a socket. */
function fakeRes(events: string[] = []): Pick<ExpressResponse, 'sendStatus'> {
    return { sendStatus: (code: number) => { events.push(`status:${code}`); return undefined as never; } };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

let server: Server;
let origin: string;
/** What the route runs after its 200; each test sets it. */
let work: () => Promise<unknown>;
/** What `waitUntil` was handed, in order. */
let handed: Promise<unknown>[];
let lines: Array<{ event: string; level: string }>;
let restoreSink: (() => void) | undefined;
let restoreWaitUntil: (() => void) | undefined;
let restoreQueue: (() => void) | undefined;

before(async () => {
    const app = express();
    app.post('/hook', (_req, res) => {
        // Exactly the shape of the real route's tail: not awaited.
        void acknowledgeThenRun(res, () => work());
    });
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    handed = [];
    lines = [];
    work = async () => {};
    const previousSink = setLogSink((level, line) => { lines.push({ level, ...JSON.parse(line) }); });
    restoreSink = () => setLogSink(previousSink);
    const previousWait = setWaitUntil((promise) => { handed.push(promise); });
    restoreWaitUntil = () => { setWaitUntil(previousWait); };
});

afterEach(() => {
    restoreSink?.();
    restoreWaitUntil?.();
    restoreQueue?.();
    restoreQueue = undefined;
    delete (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT];
});

async function post(): Promise<Response> {
    const res = await fetch(`${origin}/hook`, { method: 'POST' });
    await res.text();
    return res;
}

describe('acknowledgeThenRun: the order', () => {
    it('sends the 200 before the work starts', async () => {
        const events: string[] = [];
        const done = acknowledgeThenRun(fakeRes(events), async () => { events.push('work'); });
        await done;
        assert.deepEqual(events, ['status:200', 'work']);
    });

    it('answers over HTTP while the work is still running, and the work finishes afterwards', async () => {
        const gate = deferred();
        let started = false;
        let finished = false;
        work = async () => { started = true; await gate.promise; finished = true; };

        const res = await post();

        assert.equal(res.status, 200);
        assert.equal(started, true, 'the work was started, not just handed over');
        assert.equal(finished, false, 'the client has its 200 while the work is still going');

        gate.resolve();
        await handed[0];
        assert.equal(finished, true, 'the work ran to completion after the response');
    });

    it('answers 200 while the real inline drain is still at its first await, then lets it claim', async () => {
        const gate = deferred();
        let claims = 0;
        const queue: JobQueue = {
            enqueue: async () => null,
            // `drainInline` reaps first; holding that holds the whole drain.
            reapStale: async () => { await gate.promise; return 0; },
            claim: async () => { claims++; return []; },
            complete: async () => {},
            fail: async () => {},
            pruneCompleted: async () => 0,
        };
        const previous = setJobQueue(queue);
        restoreQueue = () => { setJobQueue(previous); };
        work = () => drainInline();

        const res = await post();

        assert.equal(res.status, 200);
        assert.equal(claims, 0, 'the drain had not claimed anything when the 200 was sent');

        gate.resolve();
        await handed[0];
        assert.ok(claims >= 1, 'the drain carried on after the response and claimed');
    });
});

describe('acknowledgeThenRun: the handoff', () => {
    it('hands waitUntil the promise that runs the work, once, not yet settled', async () => {
        const gate = deferred();
        work = async () => { await gate.promise; };

        await post();

        assert.equal(handed.length, 1, 'waitUntil must receive the work');
        const settled = Symbol('pending');
        assert.equal(await Promise.race([handed[0], Promise.resolve(settled)]), settled,
            'the promise waitUntil holds is the work itself, still running');

        gate.resolve();
        await handed[0];
    });

    it('is the promise the function returns, so a caller that awaits it waits for the same thing', async () => {
        const returned = acknowledgeThenRun(fakeRes(), async () => {});
        assert.equal(handed.length, 1);
        assert.equal(handed[0], returned);
        await returned;
    });
});

describe('acknowledgeThenRun: failures stay inside', () => {
    let unhandled: unknown[];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    beforeEach(() => { unhandled = []; process.on('unhandledRejection', onUnhandled); });
    afterEach(() => { process.off('unhandledRejection', onUnhandled); });

    it('a rejected drain settles the promise waitUntil holds, and is logged, not unhandled', async () => {
        work = async () => { throw new Error('pool exhausted'); };

        const res = await post();
        assert.equal(res.status, 200, 'a failing drain does not change the answer Meta already has');

        await handed[0]; // would throw here if the promise could reject
        await tick();
        await tick();

        assert.deepEqual(unhandled, [], 'no unhandled rejection');
        const logged = lines.filter((l) => l.event === 'webhook.pipeline_error');
        assert.equal(logged.length, 1);
        assert.equal(logged[0]!.level, 'error');
    });

    it('a work function that throws before returning a promise is contained too', async () => {
        work = (() => { throw new Error('thrown synchronously'); }) as () => Promise<unknown>;

        await post();
        await handed[0];
        await tick();

        assert.deepEqual(unhandled, []);
        assert.equal(lines.filter((l) => l.event === 'webhook.pipeline_error').length, 1);
    });

    it('a waitUntil that throws does not reach the request, and the work still runs', async () => {
        setWaitUntil(() => { throw new Error('no such request context'); });
        let ran = false;
        work = async () => { ran = true; };

        const res = await post();
        await tick();

        assert.equal(res.status, 200);
        assert.equal(ran, true);
        assert.equal(lines.filter((l) => l.event === 'runtime.wait_until_failed').length, 1);
    });
});

describe('acknowledgeThenRun: outside Vercel, and on it', () => {
    const savedVercel = process.env['VERCEL'];
    beforeEach(() => {
        // Put the real package back: these two cases are about what it does.
        setWaitUntil(platformWaitUntil);
        delete process.env['VERCEL'];
    });
    afterEach(() => {
        if (savedVercel === undefined) delete process.env['VERCEL'];
        else process.env['VERCEL'] = savedVercel;
    });

    it('with no request context the work still runs (dev and tests have none)', async () => {
        assert.equal((globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT], undefined);
        const gate = deferred();
        let finished = false;
        work = async () => { await gate.promise; finished = true; };

        const res = await post();
        assert.equal(res.status, 200);
        assert.equal(finished, false);

        gate.resolve();
        await tick();
        await tick();
        assert.equal(finished, true, 'started by the caller, so it runs although waitUntil is a no-op here');
        assert.deepEqual(lines.filter((l) => l.level !== 'info'), [], 'and says nothing: this is the normal local state');
    });

    it('with a request context, the real @vercel/functions hands the work to the platform', async () => {
        const received: Promise<unknown>[] = [];
        (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
            get: () => ({ waitUntil: (p: Promise<unknown>) => { received.push(p); } }),
        };
        let ran = false;
        work = async () => { ran = true; };

        await post();
        await tick();

        assert.equal(received.length, 1, 'the platform was asked to keep the invocation alive');
        await received[0];
        assert.equal(ran, true);
    });
});

describe('index.ts routes the webhook through it', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const start = source.indexOf("app.post('/webhook'");
    const end = source.indexOf('// ─── Not Found');
    const handler = source.slice(start, end);

    it('finds the handler', () => {
        assert.ok(start > 0 && end > start);
    });

    it('acknowledges real events through acknowledgeThenRun, not a bare sendStatus then an awaited drain', () => {
        assert.match(handler, /void acknowledgeThenRun\(res,/);
        // The one remaining `res.sendStatus(200)` is the early return for an object this app ignores.
        assert.equal((handler.match(/res\.sendStatus\(200\)/g) ?? []).length, 1);
        assert.match(handler, /webhook\.unrecognised_object[\s\S]{0,80}res\.sendStatus\(200\)/);
    });
});
