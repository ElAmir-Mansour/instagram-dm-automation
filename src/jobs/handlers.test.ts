/**
 * The last-attempt boundary.
 *
 * Both webhook pipelines can now leave work retryable: a transient Meta or Gemini failure
 * re-raises so the runner backs off, and the domain row (`interactions.status = 'PENDING'`,
 * `messages.handled_at IS NULL`) is left in a state the next attempt resumes.
 *
 * That is only correct while there is a next attempt. Get this predicate wrong in the
 * optimistic direction and the final failure strands the row: an interaction stuck at PENDING
 * forever, which in the dashboard is indistinguishable from the webhook having stopped — the
 * single hardest failure in this project to diagnose. Wrong in the pessimistic direction and
 * the first blip is recorded as permanent, which is the behaviour this branch removed.
 *
 * The off-by-one is easy to get wrong because `attempts` is incremented by the claim, not by
 * the handler: on the first run of a fresh job it is already 1, not 0.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLastAttempt } from './handlers.js';

describe('isLastAttempt', () => {
    it('is false on the first run of a fresh job', () => {
        // The claim has already incremented `attempts` to 1, so "first attempt" is 1 of 3.
        assert.equal(isLastAttempt({ attempts: 1, max_attempts: 3 }), false);
    });

    it('is false while attempts remain', () => {
        assert.equal(isLastAttempt({ attempts: 2, max_attempts: 3 }), false);
    });

    it('is true on the attempt that spends the budget', () => {
        assert.equal(isLastAttempt({ attempts: 3, max_attempts: 3 }), true);
    });

    it('is true past the budget, which a requeued stale claim can reach', () => {
        assert.equal(isLastAttempt({ attempts: 4, max_attempts: 3 }), true);
    });

    it('is true for a job allowed only one attempt', () => {
        // `max_attempts: 1` means there is no retry at all, so nothing may be left pending.
        assert.equal(isLastAttempt({ attempts: 1, max_attempts: 1 }), true);
    });

    it('agrees with the runner, which gives up on exactly the same condition', () => {
        // src/jobs/runner.ts: `const exhausted = job.attempts >= job.max_attempts`. If these
        // two ever disagree, a handler leaves a row retryable for an attempt the runner has
        // already decided not to schedule.
        for (let attempts = 1; attempts <= 5; attempts++) {
            const max = 3;
            assert.equal(isLastAttempt({ attempts, max_attempts: max }), attempts >= max);
        }
    });
});
