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
import {
    describeInspection, inspectionStatus, REQUIRED_SCOPES, tokenDeathReason,
} from './tokenHealth.js';

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

/**
 * Reading a `debug_token` response.
 *
 * The cases here are the ones that have actually misled somebody. A never-expiring PAGE token
 * reports `expires_at: 0`, which read naively becomes "expired in 1970"; and
 * `data_access_expires_at` — the 90-day window that lapses independently of the token and
 * stops every read when it does — was simply never looked at, so the dashboard said "never
 * expires" about a token that was going to stop working on a date `scripts/diagnose.mjs` could
 * already name.
 */
const HEALTHY = {
    is_valid: true,
    type: 'PAGE',
    expires_at: 0,
    data_access_expires_at: Math.floor(Date.now() / 1000) + 89 * 86_400,
    scopes: [...REQUIRED_SCOPES],
};

describe('describeInspection', () => {
    it('reads a healthy never-expiring PAGE token as healthy', () => {
        const result = describeInspection(HEALTHY);

        assert.equal(result.isValid, true);
        assert.equal(result.type, 'PAGE');
        // 0 means "never expires", which is what this app needs — not the epoch.
        assert.equal(result.expiresAt, null);
        assert.deepEqual(result.missingScopes, []);
        assert.equal(result.error, null);
        assert.equal(inspectionStatus(result), 'valid');
    });

    it('reads the data-access window that the status endpoint used to ignore', () => {
        const result = describeInspection(HEALTHY);

        assert.ok(result.dataAccessExpiresAt instanceof Date);
        // Roughly 89 days out, which is what production actually reports today.
        const days = (result.dataAccessExpiresAt.getTime() - Date.now()) / 86_400_000;
        assert.ok(days > 88 && days < 90, `got ${days} days`);
    });

    it('calls a lapsed data-access window invalid, even though Meta says the token is valid', () => {
        // The trap: `is_valid` stays true and `expires_at` stays 0, so every naive check
        // reports a perfectly healthy token while every Meta call returns code 190.
        const result = describeInspection({
            ...HEALTHY, data_access_expires_at: Math.floor(Date.now() / 1000) - 86_400,
        });

        assert.equal(result.isValid, true);
        assert.equal(inspectionStatus(result), 'invalid');
        assert.match(result.error!, /Data access has expired/);
    });

    it('calls a USER token invalid and says which type it got', () => {
        const result = describeInspection({ ...HEALTHY, type: 'USER' });

        assert.equal(inspectionStatus(result), 'invalid');
        assert.match(result.error!, /USER/);
        assert.match(result.error!, /PAGE access token is required/);
    });

    it('keeps a token with missing scopes VALID, and names them', () => {
        // Deliberate: the token works, some features do not. Marking it invalid would send the
        // operator to regenerate something that is not broken — and a missing scope is an
        // app-review problem, not a token problem.
        const result = describeInspection({
            ...HEALTHY, scopes: REQUIRED_SCOPES.filter((s) => s !== 'instagram_manage_messages'),
        });

        assert.equal(inspectionStatus(result), 'valid');
        assert.deepEqual(result.missingScopes, ['instagram_manage_messages']);
        assert.match(result.error!, /instagram_manage_messages/);
    });

    it('prefers Meta\'s own reason when the token is not valid', () => {
        const result = describeInspection({
            is_valid: false, error: { message: 'Session has been invalidated' },
        });

        assert.equal(inspectionStatus(result), 'invalid');
        assert.match(result.error!, /Session has been invalidated/);
    });

    it('survives a response with nothing in it', () => {
        // A Graph API change, or an error body where the data was expected. Must not throw
        // inside a catch-free path, and must not conclude "valid".
        for (const data of [undefined, null, {}, { is_valid: true }]) {
            const result = describeInspection(data);
            assert.equal(typeof result.isValid, 'boolean');
            assert.deepEqual(result.scopes, []);
        }
        assert.equal(inspectionStatus(describeInspection(undefined)), 'invalid');
    });

    it('treats a real future expiry as a real expiry', () => {
        const in30Days = Math.floor(Date.now() / 1000) + 30 * 86_400;
        const result = describeInspection({ ...HEALTHY, expires_at: in30Days });

        assert.ok(result.expiresAt instanceof Date);
        assert.equal(Math.round(result.expiresAt.getTime() / 1000), in30Days);
        // An expiring token is not yet broken, so it stays valid — the date is the warning.
        assert.equal(inspectionStatus(result), 'valid');
    });
});
