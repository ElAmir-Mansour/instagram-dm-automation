/**
 * The per-request profile cache (docs/onboarding/01 §4): shared inside a request, absent outside one, cleared
 * on a save, and never keeping a failed read. Its wiring into `src/index.ts` is held here too, because nothing
 * else would notice if it came out: every reader would simply go back to the database.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { cachedForRequest, clearProfileCache, profileCacheScope, withProfileCache } from './cache.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

/** A loader that counts its calls and answers `value`, or rejects when told to. */
function loader<T>(value: T) {
    const state = { calls: 0, fail: false };
    const load = async (): Promise<T> => {
        state.calls++;
        await Promise.resolve();
        if (state.fail) throw new Error('read failed');
        return value;
    };
    return { state, load };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('outside a scope', () => {
    it('caches nothing: tests, scripts and the worker see the database every time', async () => {
        const { state, load } = loader('x');
        assert.equal(await cachedForRequest(A, load), 'x');
        assert.equal(await cachedForRequest(A, load), 'x');
        assert.equal(state.calls, 2);
    });

    it('clearing is a no-op, not an error', () => {
        assert.doesNotThrow(() => clearProfileCache(A));
    });
});

describe('inside a scope', () => {
    it('answers the second ask from the first, and keeps tenants apart', async () => {
        await withProfileCache(async () => {
            const a = loader('profile of A');
            const b = loader('profile of B');
            assert.equal(await cachedForRequest(A, a.load), 'profile of A');
            assert.equal(await cachedForRequest(A, a.load), 'profile of A');
            assert.equal(await cachedForRequest(B, b.load), 'profile of B');
            assert.equal(a.state.calls, 1);
            assert.equal(b.state.calls, 1);
        });
    });

    it('shares one query between readers that ask at the same moment', async () => {
        await withProfileCache(async () => {
            const { state, load } = loader(7);
            const answers = await Promise.all([cachedForRequest(A, load), cachedForRequest(A, load), cachedForRequest(A, load)]);
            assert.deepEqual(answers, [7, 7, 7]);
            assert.equal(state.calls, 1);
        });
    });

    it('holds across awaits, timers and a callback that outlives the call that opened it', async () => {
        const { state, load } = loader('x');
        await withProfileCache(async () => {
            await cachedForRequest(A, load);
            await new Promise((resolve) => setTimeout(resolve, 5));
            await tick();
            await cachedForRequest(A, load);
            await new Promise<void>((resolve) => setImmediate(() => void cachedForRequest(A, load).then(() => resolve())));
        });
        assert.equal(state.calls, 1);
    });

    it('is forgotten when the request ends: the next scope starts empty', async () => {
        const { state, load } = loader('x');
        await withProfileCache(() => cachedForRequest(A, load));
        await withProfileCache(() => cachedForRequest(A, load));
        assert.equal(state.calls, 2, 'a profile saved by another request is read by the next one');
    });

    it('keeps two requests running at once apart', async () => {
        const first = loader('first');
        const second = loader('second');
        const [a, b] = await Promise.all([
            withProfileCache(async () => {
                await cachedForRequest(A, first.load);
                await tick();
                return cachedForRequest(A, first.load);
            }),
            withProfileCache(async () => {
                await tick();
                return cachedForRequest(A, second.load);
            }),
        ]);
        assert.equal(a, 'first');
        assert.equal(b, 'second', 'the other request did not read the first one\'s entry');
        assert.equal(first.state.calls, 1);
        assert.equal(second.state.calls, 1);
    });

    it('clearing forgets that tenant only', async () => {
        await withProfileCache(async () => {
            const a = loader('A');
            const b = loader('B');
            await cachedForRequest(A, a.load);
            await cachedForRequest(B, b.load);
            clearProfileCache(A);
            await cachedForRequest(A, a.load);
            await cachedForRequest(B, b.load);
            assert.equal(a.state.calls, 2, 'A is read again');
            assert.equal(b.state.calls, 1, 'B is still cached');
        });
    });

    it('drops a rejected promise, so one failed read is not the answer for the rest of the request', async () => {
        await withProfileCache(async () => {
            const { state, load } = loader('ok');
            state.fail = true;
            await assert.rejects(cachedForRequest(A, load), /read failed/);
            await tick();
            state.fail = false;
            assert.equal(await cachedForRequest(A, load), 'ok');
            assert.equal(await cachedForRequest(A, load), 'ok');
            assert.equal(state.calls, 2, 'one failed read, one good one, and then it is cached');
        });
    });

    it('hands every concurrent reader the same failure, and then forgets it', async () => {
        await withProfileCache(async () => {
            const { state, load } = loader('ok');
            state.fail = true;
            const results = await Promise.allSettled([cachedForRequest(A, load), cachedForRequest(A, load)]);
            assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
            assert.equal(state.calls, 1);
            await tick();
            state.fail = false;
            assert.equal(await cachedForRequest(A, load), 'ok');
        });
    });

    it('an old failure does not delete the entry that replaced it', async () => {
        // load 1 is in flight; a save clears the tenant; load 2 starts and is cached; load 1 then fails.
        // Deleting by key would throw away load 2, which is the good one.
        await withProfileCache(async () => {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            let calls = 0;
            const slowFailure = async (): Promise<string> => {
                calls++;
                await gate;
                throw new Error('old read failed');
            };
            const fresh = loader('fresh');

            const old = cachedForRequest(A, slowFailure);
            old.catch(() => undefined);
            clearProfileCache(A);
            assert.equal(await cachedForRequest(A, fresh.load), 'fresh');
            release();
            await tick();
            await assert.rejects(old, /old read failed/);

            assert.equal(await cachedForRequest(A, fresh.load), 'fresh');
            assert.equal(fresh.state.calls, 1, 'the entry that replaced the failure is still there');
            assert.equal(calls, 1);
        });
    });
});

describe('profileCacheScope, the middleware', () => {
    it('opens a scope for everything the rest of the request does', async () => {
        const { state, load } = loader('x');
        await new Promise<void>((resolve, reject) => {
            const next = (() => {
                cachedForRequest(A, load).then(() => cachedForRequest(A, load)).then(() => resolve(), reject);
            }) as NextFunction;
            profileCacheScope({} as Request, {} as Response, next);
        });
        assert.equal(state.calls, 1);
    });

    it('does not leak into the code that runs after it returns', async () => {
        const { state, load } = loader('x');
        profileCacheScope({} as Request, {} as Response, (() => undefined) as NextFunction);
        await cachedForRequest(A, load);
        await cachedForRequest(A, load);
        assert.equal(state.calls, 2, 'outside the request, nothing is cached');
    });
});

describe('the wiring in src/index.ts', () => {
    const source = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');

    it('opens the scope for every request: after the log context, before the first route or body of work', () => {
        const logContext = source.indexOf('withLogContext({ request_id');
        const scope = source.indexOf('app.use(profileCacheScope);');
        const headers = source.indexOf('app.use(securityHeaders);');
        assert.ok(logContext > 0, 'the log context middleware is found');
        assert.ok(scope > logContext, 'next to the log context, after it');
        assert.ok(scope < headers, 'ahead of the security headers and every route');
        assert.match(source, /import \{ profileCacheScope \} from '\.\/services\/profile\/cache\.js';/);
    });

    it('is opened once', () => {
        assert.equal(source.split('profileCacheScope').length - 1, 2, 'one import, one use');
    });
});
