/**
 * The retention policy decision.
 *
 * Clearing `raw_payload` is irreversible and this runs against a live account, so what
 * matters most here is the set of inputs that must NOT start deleting: unset, blank,
 * mistyped, or a window short enough to destroy the evidence you would need to debug a
 * webhook problem that is still happening.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../utils/log.js';
import {
    JOB_PRUNE_BATCH_SIZE,
    MAX_SWEEP_PASSES,
    MIN_RETENTION_DAYS,
    PRUNE_BATCH_SIZE,
    pruneOrphanedMedia,
    resolveRetention,
    runRetentionSweep,
} from './retention.js';

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

/**
 * The sweep's termination rules.
 *
 * `pruneRawPayloads` clears one batch of 5,000. That is right for one statement and wrong for
 * the only thing that calls it: the once-daily cron. An account with 60,000 unpruned messages
 * would have taken twelve days to converge, and for eleven of them the published
 * /data-deletion promise stays untrue — which is the most serious non-security issue in
 * ARCHITECTURE.md.
 *
 * Two mistakes are possible here and both are bad: stopping too early (never converging) and
 * not stopping at all (monopolising an invocation with a wall clock).
 */
describe('runRetentionSweep', () => {
    let restoreSink: (() => void) | undefined;
    before(() => {
        const previous = setLogSink(() => {});
        restoreSink = () => setLogSink(previous);
    });
    after(() => restoreSink?.());

    /** Pruners that report a scripted count per pass, then zero. */
    function scripted(rawCounts: number[], jobCounts: number[] = [], mediaCounts: number[] = []) {
        let rawPass = 0;
        let jobPass = 0;
        let mediaPass = 0;
        return {
            pruneRaw: async () => ({ cleared: rawCounts[rawPass++] ?? 0, skipped: false }),
            pruneJobs: async () => ({ deleted: jobCounts[jobPass++] ?? 0 }),
            // Defaults to nothing-to-do, which is the real default: media retention is
            // opt-in, so every existing assertion below keeps meaning what it meant.
            pruneMedia: async () => ({ deleted: mediaCounts[mediaPass++] ?? 0, skipped: false as const }),
        };
    }

    it('stops after one pass when there was nothing to do', async () => {
        // The common case by far: retention unset, no completed jobs. It must not cost 20
        // round-trips a day to discover that.
        const result = await runRetentionSweep(scripted([0], [0]));

        assert.equal(result.passes, 1);
        assert.equal(result.rawPayloadsCleared, 0);
        assert.equal(result.moreRemaining, false);
    });

    it('stops after a partial batch, which means the backlog is caught up', async () => {
        const result = await runRetentionSweep(scripted([12], [3]));

        assert.equal(result.passes, 1);
        assert.equal(result.rawPayloadsCleared, 12);
        assert.equal(result.jobsDeleted, 3);
    });

    it('keeps going while batches come back full, and converges in one run', async () => {
        // The bug this fixes: three full batches used to be three days of waiting.
        const result = await runRetentionSweep(
            scripted([PRUNE_BATCH_SIZE, PRUNE_BATCH_SIZE, 17], [0, 0, 0])
        );

        assert.equal(result.passes, 3);
        assert.equal(result.rawPayloadsCleared, PRUNE_BATCH_SIZE * 2 + 17);
        assert.equal(result.moreRemaining, false);
    });

    it('keeps going for a full job batch too, not only raw payloads', async () => {
        const result = await runRetentionSweep(
            scripted([0, 0], [JOB_PRUNE_BATCH_SIZE, 4])
        );

        assert.equal(result.passes, 2);
        assert.equal(result.jobsDeleted, JOB_PRUNE_BATCH_SIZE + 4);
    });

    it('keeps going for a full media batch too', async () => {
        // Same convergence rule as the other two sweeps. Without it, reclaiming a large
        // media backlog would take one batch per day - and media is the sweep most likely
        // to have a backlog, because nothing has ever deleted from media_uploads.
        const result = await runRetentionSweep(scripted([0, 0], [0, 0], [PRUNE_BATCH_SIZE, 6]));

        assert.equal(result.passes, 2);
        assert.equal(result.mediaDeleted, PRUNE_BATCH_SIZE + 6);
        assert.equal(result.moreRemaining, false);
    });

    it('gives up after the pass cap rather than running until the invocation dies', async () => {
        // An endless supply of full batches. The cap is what stops a sweep from eating the
        // cron invocation that has scheduled posts to publish after it.
        const endless = {
            pruneRaw: async () => ({ cleared: PRUNE_BATCH_SIZE, skipped: false }),
            pruneJobs: async () => ({ deleted: 0 }),
            pruneMedia: async () => ({ deleted: 0 as const, skipped: true as const, reason: 'disabled' as const }),
        };
        const result = await runRetentionSweep(endless);

        assert.equal(result.passes, MAX_SWEEP_PASSES);
        assert.equal(result.moreRemaining, true, 'and says so, so the operator knows to expect another run');
    });
});

describe('media retention gating', () => {
    let saved: string | undefined;

    beforeEach(() => { saved = process.env.MEDIA_RETENTION_DAYS; });
    afterEach(() => {
        if (saved === undefined) delete process.env.MEDIA_RETENTION_DAYS;
        else process.env.MEDIA_RETENTION_DAYS = saved;
    });

    it('does nothing when unset — this is an irreversible delete of the operator\'s own media', async () => {
        delete process.env.MEDIA_RETENTION_DAYS;
        const out = await pruneOrphanedMedia();
        // `reason` is the whole point: without it, "retention is off" and "the DELETE threw"
        // are the same value, and this assertion passes even when the gate is removed.
        assert.deepEqual(out, { deleted: 0, skipped: true, reason: 'disabled' });
    });

    it('refuses a window below the minimum rather than silently using a default', async () => {
        // Falling back to a default would delete media the operator never agreed to lose.
        for (const bad of ['0', '1', '6', '-30', 'thirty', '']) {
            process.env.MEDIA_RETENTION_DAYS = bad;
            const out = await pruneOrphanedMedia();
            assert.deepEqual(out, { deleted: 0, skipped: true, reason: 'disabled' }, `value ${JSON.stringify(bad)}`);
        }
    });

    it('accepts the minimum and above', () => {
        for (const good of [String(MIN_RETENTION_DAYS), '30', '365']) {
            assert.equal(resolveRetention(good).enabled, true, `value ${good}`);
        }
    });
});
