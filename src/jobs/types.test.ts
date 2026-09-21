/**
 * The job-kind guard.
 *
 * Small, but it is the thing standing between "one row in `jobs` has a kind nobody
 * recognises" and "the drain throws on every pass and no tenant's work gets done". A rollback
 * that removes a handler while jobs of that kind are still queued is the realistic way to get
 * there.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JOB_KINDS, isJobKind } from './types.js';

describe('isJobKind', () => {
    it('accepts every kind in the registry', () => {
        for (const kind of JOB_KINDS) assert.equal(isJobKind(kind), true, kind);
    });

    it('rejects anything else, including near-misses', () => {
        for (const value of ['comment', 'comment.processs', 'COMMENT.PROCESS', 'dm', '']) {
            assert.equal(isJobKind(value), false, JSON.stringify(value));
        }
    });

    it('rejects non-strings rather than throwing on them', () => {
        // The value arrives from a JSONB column, so it is whatever is in the database.
        for (const value of [null, undefined, 42, {}, [], true]) {
            assert.equal(isJobKind(value), false, JSON.stringify(value) ?? 'undefined');
        }
    });

    it('does not treat inherited Array members as kinds', () => {
        // `includes` on the tuple, not `in` — guards against a value like 'length'.
        assert.equal(isJobKind('length'), false);
        assert.equal(isJobKind('0'), false);
    });
});
