/**
 * Acknowledge Meta, then do the work, without the work being frozen.
 *
 * `POST /webhook` answers 200 as soon as the events are in the `jobs` table, and only then
 * drains. On Vercel an invocation can be frozen as soon as its response is sent, which left an
 * inline-claimed job `running` until the instance happened to thaw (the next request, about
 * 70 s later, or the stale-claim reaper at 300 s). Handing the drain to `waitUntil` keeps the
 * invocation alive until it settles, so a DM or a comment reply goes out seconds after the
 * 200 and not minutes.
 *
 * It is a function of its own, not inline in the route, because the route lives in `index.ts`,
 * which binds a port when it is imported: this is the part that can be tested.
 */
import type { Response } from 'express';
import { describeError, log } from '../utils/log.js';
import { waitUntil } from '../utils/waitUntil.js';

/**
 * Send 200, then run `work` under `waitUntil`. The 200 goes out first and is never held back
 * by the work (Meta's webhook timeout is about 20 s).
 *
 * The caller must NOT await the result after calling this: the response is already sent, and
 * awaiting it is what made the invocation depend on a thaw. It is returned only so a test can
 * wait for the work. It never rejects: whatever `work` throws is logged as
 * `webhook.pipeline_error`, which both pipelines reach only when something outside their
 * per-event handlers broke.
 *
 * `work` starts running now, before `waitUntil` is called, because `waitUntil` runs nothing and
 * outside Vercel (dev, tests) does nothing at all.
 */
export function acknowledgeThenRun(res: Pick<Response, 'sendStatus'>, work: () => Promise<unknown>): Promise<void> {
    res.sendStatus(200);

    const settled = (async () => {
        try {
            await work();
        } catch (err) {
            // Both paths isolate every entry and every event inside them, so reaching here
            // means something outside the per-event handlers broke. The response is already
            // sent; all that is left is to make it visible.
            log('error', 'webhook.pipeline_error', describeError(err));
        }
    })();

    waitUntil(settled);
    return settled;
}
