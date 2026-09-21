/**
 * Retry policy for Meta Graph API calls.
 *
 * The expensive half of this is not "does it retry" — it is "does it stop". Hammering Meta
 * with a dead token or a permission it was never granted is how an app attracts enforcement
 * attention, and at DM volume that is the difference between one failed send and a suspended
 * app. Every test here passes `baseMs: 1` so the suite never actually sleeps.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPermanentMetaError, withRetry } from './http.js';

/** An axios-shaped Meta API error. */
function metaError(code: number, status = 400): unknown {
    return { response: { status, data: { error: { code, message: `code ${code}` } } } };
}

/** An axios-shaped HTTP error carrying no Meta error code. */
function httpError(status: number): unknown {
    return { response: { status, data: {} } };
}

/** A network-level failure: no HTTP response at all. */
function networkError(code: string): unknown {
    return { code, message: code };
}

/** withRetry logs a warning per attempt; keep the test output readable. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
    const warn = console.warn;
    console.warn = () => {};
    try {
        return await fn();
    } finally {
        console.warn = warn;
    }
}

function counted(behaviour: (attempt: number) => unknown) {
    const state = { calls: 0 };
    const fn = async (): Promise<string> => {
        state.calls += 1;
        const result = behaviour(state.calls);
        if (result !== undefined) throw result;
        return 'ok';
    };
    return { fn, state };
}

describe('withRetry', () => {
    it('returns the result without retrying when the call succeeds', async () => {
        const { fn, state } = counted(() => undefined);

        assert.equal(await withRetry(fn, { baseMs: 1 }), 'ok');
        assert.equal(state.calls, 1);
    });

    it('retries a 500 and returns the eventual success', async () => {
        const { fn, state } = counted((attempt) => (attempt === 1 ? httpError(500) : undefined));

        assert.equal(await quietly(() => withRetry(fn, { baseMs: 1 })), 'ok');
        assert.equal(state.calls, 2);
    });

    it('retries a 429', async () => {
        const { fn, state } = counted((attempt) => (attempt < 3 ? httpError(429) : undefined));

        assert.equal(await quietly(() => withRetry(fn, { baseMs: 1 })), 'ok');
        assert.equal(state.calls, 3);
    });

    it('gives up after the configured retries and rethrows the last error', async () => {
        const { fn, state } = counted(() => httpError(503));

        await assert.rejects(
            () => quietly(() => withRetry(fn, { retries: 2, baseMs: 1 })),
            (err: any) => err.response.status === 503,
        );
        // One initial attempt plus two retries.
        assert.equal(state.calls, 3);
    });

    it('defaults to three retries', async () => {
        const { fn, state } = counted(() => httpError(500));

        await assert.rejects(() => quietly(() => withRetry(fn, { baseMs: 1 })));
        assert.equal(state.calls, 4);
    });

    for (const [code, meaning] of [
        [190, 'invalid or expired access token'],
        [200, 'insufficient permission'],
        [10903, 'recipient has blocked DMs from businesses'],
    ] as Array<[number, string]>) {
        it(`does not retry Meta code ${code} (${meaning})`, async () => {
            const { fn, state } = counted(() => metaError(code));

            await assert.rejects(() => withRetry(fn, { baseMs: 1 }));
            assert.equal(state.calls, 1, 'a permanent failure must cost exactly one call');
        });
    }

    it('treats a permanent code as permanent even behind a 500', async () => {
        // The status alone would say "retryable"; the error code is the stronger signal.
        const { fn, state } = counted(() => metaError(190, 500));

        await assert.rejects(() => withRetry(fn, { baseMs: 1 }));
        assert.equal(state.calls, 1);
    });

    for (const code of [1, 2, 4, 17, 32, 341, 613]) {
        it(`retries transient Meta code ${code}`, async () => {
            const { fn, state } = counted((attempt) => (attempt === 1 ? metaError(code) : undefined));

            assert.equal(await quietly(() => withRetry(fn, { baseMs: 1 })), 'ok');
            assert.equal(state.calls, 2);
        });
    }

    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN']) {
        it(`retries network error ${code}`, async () => {
            const { fn, state } = counted((attempt) => (attempt === 1 ? networkError(code) : undefined));

            assert.equal(await quietly(() => withRetry(fn, { baseMs: 1 })), 'ok');
            assert.equal(state.calls, 2);
        });
    }

    it('does not retry a plain 4xx', async () => {
        for (const status of [400, 403, 404]) {
            const { fn, state } = counted(() => httpError(status));

            await assert.rejects(() => withRetry(fn, { baseMs: 1 }));
            assert.equal(state.calls, 1, `status ${status}`);
        }
    });

    it('does not retry an error that is not an HTTP failure at all', async () => {
        // A bug in our own code should surface on the first attempt, not three times over.
        const { fn, state } = counted(() => new TypeError('bad argument'));

        await assert.rejects(() => withRetry(fn, { baseMs: 1 }), TypeError);
        assert.equal(state.calls, 1);
    });
});

describe('isPermanentMetaError', () => {
    it('recognises the permanent codes', () => {
        assert.equal(isPermanentMetaError(metaError(190)), true);
        assert.equal(isPermanentMetaError(metaError(200)), true);
        assert.equal(isPermanentMetaError(metaError(10903)), true);
    });

    it('does not claim transient, unknown or absent codes', () => {
        assert.equal(isPermanentMetaError(metaError(4)), false);
        assert.equal(isPermanentMetaError(metaError(99999)), false);
        assert.equal(isPermanentMetaError(httpError(500)), false);
        assert.equal(isPermanentMetaError(networkError('ECONNRESET')), false);
    });

    it('survives shapes that carry no error code', () => {
        assert.equal(isPermanentMetaError(undefined), false);
        assert.equal(isPermanentMetaError(null), false);
        assert.equal(isPermanentMetaError(new Error('boom')), false);
        // A code that arrives as a string — Meta has been known to serialise it that way —
        // is not matched by the numeric set.
        assert.equal(isPermanentMetaError({ response: { data: { error: { code: '190' } } } }), false);
    });
});
