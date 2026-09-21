/**
 * Two ceilings, and which one refused the send.
 *
 * Meta's app-level limit (`200 × daily active users` per hour) is a pool shared by every
 * tenant, so it does not scale with tenant count in any way the product controls: one tenant
 * with a viral reel can 429 everybody else, and the victims see "some DMs failed" with nothing
 * saying that another customer caused it. The per-creator bucket alone cannot express this —
 * N tenants × 180/hr has no relationship to the app-wide pool.
 *
 * These tests cover the precedence and the counting, which is where the mistakes are. The SQL
 * upserts themselves need a database.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkFairSendQuota, type QuotaResult } from './rateLimiter.js';

function quota(count: number, limit: number): QuotaResult {
    return { allowed: count <= limit, count, limit };
}

/** Records how many times each bucket was consulted, which is itself load-bearing. */
function deps(creator: QuotaResult, app: QuotaResult) {
    const calls = { creator: 0, app: 0 };
    return {
        calls,
        injected: {
            creatorQuota: async () => { calls.creator++; return creator; },
            appQuota: async () => { calls.app++; return app; },
        },
    };
}

describe('checkFairSendQuota', () => {
    it('allows a send that is inside both ceilings', async () => {
        const { injected } = deps(quota(5, 180), quota(20, 1000));
        const result = await checkFairSendQuota('creator-1', 'dm', 180, injected);

        assert.equal(result.allowed, true);
        assert.equal(result.blockedBy, null);
        assert.equal(result.count, 5, 'reports the creator bucket when allowed');
    });

    it("blocks on the creator's own ceiling and says so", async () => {
        const { injected } = deps(quota(181, 180), quota(20, 1000));
        const result = await checkFairSendQuota('creator-1', 'dm', 180, injected);

        assert.equal(result.allowed, false);
        assert.equal(result.blockedBy, 'creator');
        assert.equal(result.count, 181);
    });

    it('blocks on the app-wide pool even when the tenant is well inside its own budget', async () => {
        // The cross-tenant case. Without this the tenant sees a failure with no cause: their
        // own counter reads 3 of 180 and everything looks fine.
        const { injected } = deps(quota(3, 180), quota(1001, 1000));
        const result = await checkFairSendQuota('creator-1', 'dm', 180, injected);

        assert.equal(result.allowed, false);
        assert.equal(result.blockedBy, 'app');
        assert.equal(result.count, 1001, 'reports the pool that actually refused');
    });

    it('always carries the app pool, so a refusal can be explained', async () => {
        const { injected } = deps(quota(3, 180), quota(999, 1000));
        const result = await checkFairSendQuota('creator-1', 'dm', 180, injected);

        assert.deepEqual(result.app, quota(999, 1000));
    });

    it('consumes the app pool even when the creator bucket refuses first', async () => {
        // Deliberate: both buckets are increment-then-check, which is what makes them
        // race-free. Overcounting the shared pool slows everyone slightly; undercounting it
        // is the 429 this exists to prevent.
        const { calls, injected } = deps(quota(181, 180), quota(20, 1000));
        await checkFairSendQuota('creator-1', 'dm', 180, injected);

        assert.equal(calls.creator, 1);
        assert.equal(calls.app, 1);
    });

    it('reports the creator ceiling exactly at the limit as allowed', async () => {
        // Off-by-one check on the boundary the live account actually runs against.
        const { injected } = deps(quota(180, 180), quota(20, 1000));
        assert.equal((await checkFairSendQuota('c', 'dm', 180, injected)).allowed, true);
    });
});
