/**
 * Recognising a dead Meta token.
 *
 * This is the one Meta failure that stops the whole product rather than one send, and it was
 * detected nowhere: `creators.token_status` changed only when a token was saved or when
 * somebody opened the dashboard's token page. What makes it detectable at a call site is that
 * Meta reports it as code 190 on every request, with a subcode naming which of several quite
 * different situations it is.
 *
 * The tests that matter most are the negative ones. Flipping the status on a failure that is
 * *not* a token problem sends the operator to regenerate a token that works, and there is no
 * automatic path back to `valid` except the daily check.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTokenDeathError, metaErrorCode, metaErrorSubcode } from './http.js';
import { MetaApiError } from './instagram.js';
import { tokenDeathReason } from './tokenHealth.js';

/** The axios shape, before instagram.ts wraps it. */
function axiosError(code: number, subcode?: number): unknown {
    return { message: 'Request failed', response: { data: { error: { code, error_subcode: subcode } } } };
}

/** What a Meta send path actually throws. */
function wrapped(code: number, subcode?: number): MetaApiError {
    return new MetaApiError(`DM Send Failed: nope (Code: ${code})`, axiosError(code, subcode));
}

describe('metaErrorCode / metaErrorSubcode', () => {
    it('reads the raw axios shape', () => {
        assert.equal(metaErrorCode(axiosError(190, 463)), 190);
        assert.equal(metaErrorSubcode(axiosError(190, 463)), 463);
    });

    it('reads the wrapped shape — the regression that made this necessary', () => {
        // instagram.ts used to flatten the error into a string, which is why nothing
        // downstream could tell a dead token from a rate limit.
        assert.equal(metaErrorCode(wrapped(190, 460)), 190);
        assert.equal(metaErrorSubcode(wrapped(190, 460)), 460);
    });

    it('returns undefined rather than guessing', () => {
        for (const err of [undefined, null, new Error('boom'), 'string', {}]) {
            assert.equal(metaErrorCode(err), undefined);
            assert.equal(metaErrorSubcode(err), undefined);
        }
    });
});

describe('isTokenDeathError', () => {
    it('recognises every token-death subcode', () => {
        for (const subcode of [458, 459, 460, 463, 467, 492]) {
            assert.equal(isTokenDeathError(wrapped(190, subcode)), true, `subcode ${subcode}`);
        }
    });

    it('recognises a bare 190 with no subcode', () => {
        // A subcode narrows the reason; it does not gate the conclusion.
        assert.equal(isTokenDeathError(wrapped(190)), true);
        assert.equal(isTokenDeathError(axiosError(190)), true);
    });

    it('does not fire on a code 190 with an unrelated subcode', () => {
        assert.equal(isTokenDeathError(wrapped(190, 99)), false);
    });

    it('does not fire on failures that are not about the token', () => {
        // 10903 is the recipient's privacy setting, 200 is a missing app permission (an
        // app-review problem), 4 and 2 are transient. None of them mean "paste a new token",
        // and marking the token invalid for any of them is a false alarm the operator cannot
        // easily undo.
        for (const code of [2, 4, 100, 200, 9007, 10903]) {
            assert.equal(isTokenDeathError(wrapped(code)), false, `code ${code}`);
        }
    });

    it('does not fire on a plain error with no Meta code at all', () => {
        for (const err of [undefined, null, new Error('ECONNRESET'), {}]) {
            assert.equal(isTokenDeathError(err), false);
        }
    });
});

describe('tokenDeathReason', () => {
    it('names the specific situation, because the fixes differ', () => {
        assert.match(tokenDeathReason(wrapped(190, 460)), /password was changed/i);
        assert.match(tokenDeathReason(wrapped(190, 458)), /uninstalled|authorised/i);
        assert.match(tokenDeathReason(wrapped(190, 463)), /expired/i);
        assert.match(tokenDeathReason(wrapped(190, 492)), /admin/i);
    });

    it('includes the subcode so an unrecognised one is still traceable', () => {
        assert.match(tokenDeathReason(wrapped(190, 460)), /subcode 460/);
        assert.match(tokenDeathReason(wrapped(190, 12345)), /subcode 12345/);
    });

    it('still says something useful with no subcode', () => {
        assert.match(tokenDeathReason(wrapped(190)), /code 190/);
    });
});
