/**
 * Keeping an invocation alive for work that continues after its response.
 *
 * On Vercel the function instance can be frozen the moment the response has been sent, so a
 * promise left running behind `res.send…()` makes no progress until something else wakes the
 * instance. `waitUntil` (from `@vercel/functions`) tells the platform "this invocation is not
 * finished until this promise settles". It finds the request through
 * `globalThis[Symbol.for('@vercel/request-context')]`, which the platform sets per request, and
 * is a silent no-op where that is absent: `npm run start:dev`, a script, a test.
 *
 * Two rules follow, and they are the whole reason this is a file of its own:
 *
 *   1. The work must be STARTED by the caller, not merely handed over. `waitUntil` runs nothing;
 *      with no platform context it does nothing at all, so a caller that only passes a thunk to
 *      it would never run its work locally. Callers create the promise, then pass it in.
 *   2. The handoff must never throw into the request. It runs after the 200 has gone out, where
 *      a throw reaches Express as a handler rejection and tears the connection down.
 *
 * It is a seam so tests can see what was handed over (`setWaitUntil`), the way `setLogSink`
 * lets them see what was logged.
 */
import { waitUntil as platformWaitUntil } from '@vercel/functions';
import { describeError, log } from './log.js';

export type WaitUntil = (work: Promise<unknown>) => unknown;

/** The key the Vercel runtime publishes the current request's context under (what `@vercel/functions` reads). */
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

let handoff: WaitUntil = platformWaitUntil;
let warnedUnavailable = false;

/** Replace the handoff. Returns the previous one so a test can restore it. */
export function setWaitUntil(next: WaitUntil): WaitUntil {
    const previous = handoff;
    handoff = next;
    warnedUnavailable = false;
    return previous;
}

/** Whether the platform has given this request a `waitUntil`. Never throws. */
function platformCanWait(): boolean {
    try {
        const context = (globalThis as Record<symbol, { get?: () => { waitUntil?: unknown } | undefined } | undefined>)[REQUEST_CONTEXT]?.get?.();
        return typeof context?.waitUntil === 'function';
    } catch {
        return false;
    }
}

/**
 * Ask the platform to keep this invocation alive until `work` settles.
 *
 * `work` must already be running and must never reject (see `acknowledgeThenRun`): the platform
 * waits on it, and a rejection would be nobody's to handle.
 *
 * On Vercel with no platform context the call would do nothing, and the symptom would be the
 * very latency this exists to fix, with no line saying why. So that case logs once per instance.
 */
export function waitUntil(work: Promise<unknown>): void {
    try {
        if (handoff === platformWaitUntil && process.env.VERCEL && !warnedUnavailable && !platformCanWait()) {
            warnedUnavailable = true;
            log('warn', 'runtime.wait_until_unavailable', {
                detail: 'running on Vercel but the request has no waitUntil; work after the response can be frozen',
            });
        }
        handoff(work);
    } catch (err) {
        log('error', 'runtime.wait_until_failed', describeError(err));
    }
}
