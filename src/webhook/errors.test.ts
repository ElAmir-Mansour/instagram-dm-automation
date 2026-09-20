/**
 * The status strings this produces are load-bearing — the dashboard filters on them — and the
 * awkward part is that `src/services/instagram.ts` rewraps every axios failure into a plain
 * Error with the Meta code interpolated into the message, so the structured shape is usually
 * gone by the time a real failure arrives here.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyDmError } from './errors.js';

/** What instagram.ts actually throws after a failed send. */
function rewrapped(code: number | 'N/A', message = 'Some Meta message'): Error {
    return new Error(`DM Send Failed: ${message} (Code: ${code})`);
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

    it('cannot see a dead token once instagram.ts has rewrapped it', () => {
        // Only 10903 has a string fallback, so a rewrapped 190 or 200 — the two codes the
        // retry policy treats as fatal — comes back permanent: false. Nothing reads the flag
        // today, which is the only reason this is harmless.
        assert.equal(classifyDmError(rewrapped(190)).permanent, false);
        assert.equal(classifyDmError(rewrapped(200)).permanent, false);
        assert.equal(classifyDmError(rewrapped(190)).status, 'FAILED');
    });

    it('survives a thrown value that is not an Error', () => {
        assert.equal(classifyDmError('something went wrong').error, 'something went wrong');
        assert.equal(classifyDmError(undefined).status, 'FAILED');
        assert.equal(classifyDmError(null).permanent, false);
    });
});
