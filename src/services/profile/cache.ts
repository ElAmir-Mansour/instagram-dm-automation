/**
 * A per-request cache for the stored profile (docs/onboarding/01 §4).
 *
 * Every prompt builder, every settings read and (from P4) every agent turn asks for the same tenant's
 * profile, and one request asks several times: a webhook, a dashboard page and a job drain each touch
 * a handful of readers. Without this each of them is a database round trip for the same row.
 *
 * It is an `AsyncLocalStorage`, opened once per HTTP request in `src/index.ts` next to `withLogContext`,
 * so it covers the webhook, the dashboard API and `/api/jobs/drain` alike and nothing has to thread a
 * cache through its call stack. It lives exactly as long as the request: the next request starts empty,
 * so a profile saved elsewhere is seen by the next request at the latest. What it holds is a *promise*,
 * so two readers that ask at the same moment share one query instead of racing two.
 *
 * Rules, each pinned by `cache.test.ts`:
 *   - Outside a scope (tests, scripts, a worker's own loop) nothing is cached: `cachedForRequest` runs `load`.
 *   - A reader inside a transaction bypasses it (`store.ts` does not call in): a transaction must see its
 *     own writes and must not publish what it has not committed.
 *   - `saveProfile` clears the tenant's entry once it has written, and a caller that writes inside a
 *     transaction of its own must call `clearProfileCache` after the commit.
 *   - A rejected promise is dropped, so one failed read is not the answer for the rest of the request.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

const scope = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

/** Runs `fn` inside a fresh cache scope: every `cachedForRequest` it (transitively) makes shares one map. */
export function withProfileCache<T>(fn: () => T): T {
    return scope.run(new Map(), fn);
}

/** Express middleware that opens a scope for the rest of the request, and for any work it leaves running after the response. */
export function profileCacheScope(_req: Request, _res: Response, next: NextFunction): void {
    withProfileCache(next);
}

/**
 * The tenant's cached promise, or `load()` started now and kept. Outside a scope it is just `load()`.
 * The promise is shared, so what it resolves to is shared: a caller that means to change it clones it first.
 */
export function cachedForRequest<T>(creatorId: string, load: () => Promise<T>): Promise<T> {
    const cache = scope.getStore();
    if (!cache) return load();
    const hit = cache.get(creatorId);
    if (hit) return hit as Promise<T>;
    const pending = load();
    cache.set(creatorId, pending);
    // `pending.catch` is a second branch that handles its own rejection, so this never raises an unhandled
    // one; the caller's branch (`pending` itself) still rejects for the caller. A newer promise (the entry was
    // cleared and refilled meanwhile) is not ours to delete.
    pending.catch(() => {
        if (cache.get(creatorId) === pending) cache.delete(creatorId);
    });
    return pending;
}

/** Forget the tenant's profile for the rest of this request. A no-op outside a scope. */
export function clearProfileCache(creatorId: string): void {
    scope.getStore()?.delete(creatorId);
}
