/**
 * The retention policy decision.
 *
 * Clearing `raw_payload` is irreversible and this runs against a live account, so what
 * matters most here is the set of inputs that must NOT start deleting: unset, blank,
 * mistyped, or a window short enough to destroy the evidence you would need to debug a
 * webhook problem that is still happening.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MIN_RETENTION_DAYS, resolveRetention } from './retention.js';

describe('resolveRetention', () => {
    it('is disabled when unset — the default must never delete anything', () => {
        assert.deepEqual(resolveRetention(undefined), { enabled: false, reason: 'unset' });
        assert.deepEqual(resolveRetention(''), { enabled: false, reason: 'unset' });
        assert.deepEqual(resolveRetention('   '), { enabled: false, reason: 'unset' });
    });

    it('enables pruning for a sensible window', () => {
        assert.deepEqual(resolveRetention('90'), { enabled: true, days: 90 });
        assert.deepEqual(resolveRetention('30'), { enabled: true, days: 30 });
    });

    it('accepts exactly the minimum', () => {
        assert.deepEqual(resolveRetention(String(MIN_RETENTION_DAYS)), {
            enabled: true, days: MIN_RETENTION_DAYS,
        });
    });

    it('refuses a window shorter than the minimum', () => {
        // A one-day window would clear the payloads for the webhook problem you are
        // currently trying to reproduce.
        assert.deepEqual(resolveRetention('1'), { enabled: false, reason: 'too_short' });
        assert.deepEqual(resolveRetention('6'), { enabled: false, reason: 'too_short' });
    });

    it('disables rather than guessing when the value is not a whole number of days', () => {
        // Deliberately not falling back to a default: deleting on a schedule the operator
        // did not ask for is worse than not deleting.
        for (const bad of ['abc', '90 days', '9.5', 'NaN', 'Infinity', '-30', '0', '1e3x']) {
            const result = resolveRetention(bad);
            assert.equal(result.enabled, false, `"${bad}" should not enable pruning`);
        }
    });

    it('reports invalid separately from too_short so the warning can be specific', () => {
        // The operator needs to be told which mistake they made: a typo and a too-eager
        // window want different fixes.
        assert.deepEqual(resolveRetention('abc'), { enabled: false, reason: 'invalid' });
        assert.deepEqual(resolveRetention('2'), { enabled: false, reason: 'too_short' });
    });

    it('treats a huge but valid window as enabled', () => {
        // 10 years is a policy choice, not a mistake. It is the operator's call.
        assert.deepEqual(resolveRetention('3650'), { enabled: true, days: 3650 });
    });
});
