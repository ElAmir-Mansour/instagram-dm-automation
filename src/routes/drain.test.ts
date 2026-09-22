/**
 * What the drain endpoint reports when half of it breaks.
 *
 * `/api/jobs/drain` now does two independent things: it drains the job queue, and it runs the
 * scheduled-post publish sweep. They fail for unrelated reasons — Gemini and Postgres on one
 * side, Meta publishing on the other — so the interesting behaviour is not either of them
 * working. It is what the response says when one doesn't.
 *
 * This matters because a GitHub Actions workflow asserts on the HTTP status every ~5-15
 * minutes (.github/workflows/drain.yml). Get the shaping wrong in either direction and the
 * scheduler lies: a 500 for a partial failure hides that the other half worked, and a bare
 * 200 that omits the error goes green forever while half the work never runs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { composeDrainResponse } from './api.js';

const JOBS = { claimed: 2, succeeded: 2, failed: 0, budgetExhausted: false, reaped: 0 };
const PUBLISH = { due: 1, claimed: 1, published: ['post-1'], heldForInactiveTenant: 0 };

describe('drain response shaping', () => {
    it('reports both outcomes when both halves succeed', () => {
        const { status, body } = composeDrainResponse(JOBS as never, null, PUBLISH, null);
        assert.equal(status, 200);
        assert.equal(body['claimed'], 2);
        assert.deepEqual(body['publish'], PUBLISH);
        assert.ok(!('jobsError' in body) && !('publishError' in body));
    });

    it('keeps the publish result when the queue drain throws', () => {
        // The failure this prevents: returning 500 and discarding the fact that a post did go
        // live, so the operator goes looking for a publish that already happened.
        const { status, body } = composeDrainResponse(null, 'pool exhausted', PUBLISH, null);
        assert.equal(status, 200, 'a partial failure is not a 500');
        assert.deepEqual(body['publish'], PUBLISH);
        assert.equal(body['jobsError'], 'pool exhausted');
    });

    it('keeps the drained jobs when the publish sweep throws', () => {
        const { status, body } = composeDrainResponse(JOBS as never, null, null, 'Meta token expired');
        assert.equal(status, 200);
        assert.equal(body['claimed'], 2);
        assert.equal(body['publishError'], 'Meta token expired');
        assert.equal(body['publish'], null);
    });

    it('500s only when BOTH halves failed, naming both', () => {
        const { status, body } = composeDrainResponse(null, 'pool exhausted', null, 'Meta token expired');
        assert.equal(status, 500);
        assert.equal(body['jobsError'], 'pool exhausted');
        assert.equal(body['publishError'], 'Meta token expired');
    });

    it('never returns 200 with a failure it does not name', () => {
        // The invisible-failure guard: any 200 carrying an error must say so in the body, or
        // the scheduler's status assertion goes green while work silently stops happening.
        for (const [j, je, p, pe] of [
            [JOBS, null, null, 'boom'],
            [null, 'boom', PUBLISH, null],
        ] as const) {
            const { status, body } = composeDrainResponse(j as never, je, p, pe);
            assert.equal(status, 200);
            assert.ok(
                'jobsError' in body || 'publishError' in body,
                'a 200 that hides the error would make the scheduler lie'
            );
        }
    });

    it('does not crash when a half returns nothing at all', () => {
        const { status, body } = composeDrainResponse(null, null, null, null);
        assert.equal(status, 200);
        assert.equal(body['publish'], null);
    });
});
