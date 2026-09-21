/**
 * The status strings this produces are load-bearing — the dashboard filters on them — and the
 * awkward part used to be that `src/services/instagram.ts` rewrapped every axios failure into
 * a plain Error with the Meta code interpolated into the message, so the structured shape was
 * gone by the time a real failure arrived here. It now throws `MetaApiError`, which keeps the
 * code and subcode; both shapes are exercised below because a thrown value from anywhere else
 * still arrives flat.
 *
 * `permanent` is no longer decorative. The comment pipeline reads it to decide whether to
 * leave the interaction PENDING for a retry or record it as a final failure, so a
 * misclassification is either a customer who is never answered or a dead token retried
 * against Meta three more times.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MetaApiError } from '../services/instagram.js';
import { classifyDmError } from './errors.js';

/** A bare Error carrying only the interpolated code — anything not from instagram.ts. */
function rewrapped(code: number | 'N/A', message = 'Some Meta message'): Error {
    return new Error(`DM Send Failed: ${message} (Code: ${code})`);
}

/** What instagram.ts actually throws now: the same message, with the code still attached. */
function metaApiError(code: number, subcode?: number): MetaApiError {
    return new MetaApiError(`DM Send Failed: Some Meta message (Code: ${code})`, {
        response: { data: { error: { code, error_subcode: subcode } } },
    });
}

/** The raw axios shape, as it looks before instagram.ts rewraps it. */
function structured(code: number): unknown {
    return { message: `Request failed`, response: { data: { error: { code } } } };
}

describe('classifyDmError', () => {
    it('recognises a blocked recipient from the rewrapped message string', () => {
        const classified = classifyDmError(rewrapped(10903));

        assert.equal(classified.status, 'USER_BLOCKED_DMS');
        assert.equal(classified.permanent, true);
        assert.match(classified.error, /10903/);
    });

    it('recognises a blocked recipient from the structured error too', () => {
        assert.equal(classifyDmError(structured(10903)).status, 'USER_BLOCKED_DMS');
    });

    it('records any other failure as FAILED with the original message', () => {
        const classified = classifyDmError(rewrapped(4, 'Application request limit reached'));

        assert.equal(classified.status, 'FAILED');
        assert.equal(classified.permanent, false);
        assert.match(classified.error, /Application request limit reached/);
    });

    it('marks a structured dead token or missing scope as permanent', () => {
        assert.equal(classifyDmError(structured(190)).permanent, true);
        assert.equal(classifyDmError(structured(200)).permanent, true);
    });

    it('sees a dead token through the error instagram.ts actually throws', () => {
        // This is the regression that matters: MetaApiError keeps `metaCode`, so a dead token
        // is permanent rather than being retried three more times against a token Meta has
        // already refused.
        assert.equal(classifyDmError(metaApiError(190)).permanent, true);
        assert.equal(classifyDmError(metaApiError(190, 463)).permanent, true);
        assert.equal(classifyDmError(metaApiError(200)).permanent, true);
        assert.equal(classifyDmError(metaApiError(10903)).status, 'USER_BLOCKED_DMS');
    });

    it('still sees a dead token in a message-only error, as a backstop', () => {
        // A flat Error from somewhere that predates MetaApiError. The string check is the only
        // signal left, and getting this wrong means a dead token is treated as transient and
        // hammered on every retry.
        assert.equal(classifyDmError(rewrapped(190)).permanent, true);
        assert.equal(classifyDmError(rewrapped(200)).permanent, true);
        assert.equal(classifyDmError(rewrapped(190)).status, 'FAILED');
    });

    it('keeps a transient code transient in both shapes', () => {
        // The other direction, and the one that costs a customer: code 4 is Meta's rate
        // limit. Misreading it as permanent is a comment that is never answered.
        assert.equal(classifyDmError(metaApiError(4)).permanent, false);
        assert.equal(classifyDmError(rewrapped(4)).permanent, false);
        assert.equal(classifyDmError(metaApiError(2)).permanent, false);
    });

    it('survives a thrown value that is not an Error', () => {
        assert.equal(classifyDmError('something went wrong').error, 'something went wrong');
        assert.equal(classifyDmError(undefined).status, 'FAILED');
        assert.equal(classifyDmError(null).permanent, false);
    });
});
