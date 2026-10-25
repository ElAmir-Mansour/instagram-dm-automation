/**
 * The refusals of illustrated explainers: the codes an `ExplainerError` can carry are the registry's, with the statuses the registry lists.
 *
 * The registry's own test (errorCodes.test.ts) already walks every code for its sentence and its next step in both dashboard catalogues; what it cannot know is
 * which codes the explainers send. That list is `EXPLAINER_ERROR_STATUS`, and it is a second place a status is written, so the two are compared here.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ERROR_CODES, isErrorCode } from '../errorCodes.js';
import { EXPLAINER_ERROR_STATUS, ExplainerError, type ExplainerErrorCode } from './errors.js';

const CODES = Object.keys(EXPLAINER_ERROR_STATUS) as ExplainerErrorCode[];

describe('ExplainerError', () => {
    it('carries a code that is in the registry, and a status the registry lists for it: the two places a status is written agree', () => {
        for (const code of CODES) {
            assert.ok(isErrorCode(code), `${code} is registered in ERROR_CODES`);
            const listed: readonly number[] = ERROR_CODES[code].status;
            assert.ok(listed.includes(EXPLAINER_ERROR_STATUS[code]), `${code}: ${EXPLAINER_ERROR_STATUS[code]} is not among ${listed.join(', ')}`);
        }
    });

    it('names the explainer codes the registry holds: every EXPLAINER* code is one an ExplainerError sends, except the one that is only recognised in a stored note', () => {
        const registered = Object.keys(ERROR_CODES).filter((code) => /^EXPLAINERS?_/.test(code)).sort();
        const sent = [...CODES].sort();
        const recognisedOnly = registered.filter((code) => !(sent as string[]).includes(code));
        // A code that nothing sends is not a code (errorCodes.test.ts says so of WINDOW_CLOSED): the one exception is the voice limit, which the worker writes into
        // the explainer's own note and the dashboard translates from there. Anything else here is a code that was registered and never wired.
        assert.deepEqual(recognisedOnly, ['EXPLAINER_VOICE_LIMIT']);
        assert.deepEqual(sent.filter((code) => !registered.includes(code)), [], 'and every code it sends is registered');
    });

    it('is an Error with the status of its code, and keeps its params and its extra fields as they were given', () => {
        const err = new ExplainerError('EXPLAINER_PICTURES_MISSING', 'Two scenes have no picture.', { missing: 2 }, { positions: [3, 7] });
        assert.ok(err instanceof Error);
        assert.equal(err.name, 'ExplainerError');
        assert.equal(err.code, 'EXPLAINER_PICTURES_MISSING');
        assert.equal(err.status, 409);
        assert.equal(err.message, 'Two scenes have no picture.');
        assert.deepEqual(err.params, { missing: 2 });
        assert.deepEqual(err.extra, { positions: [3, 7] });
    });

    it('has neither params nor extra when none are given, so a route does not send an empty object where there is nothing to say', () => {
        const err = new ExplainerError('EXPLAINER_NOT_FOUND', 'No such explainer.');
        assert.equal(err.status, 404);
        assert.equal(err.params, undefined);
        assert.equal(err.extra, undefined);
    });

    it('sends 429 for a paused drawing and 502 for a provider that failed: the two statuses a retry-minded client reads differently', () => {
        assert.equal(new ExplainerError('EXPLAINER_ALLOWANCE_PAUSED', 'Drawing is paused.', { retryAt: '2026-10-26T00:05:00.000Z' }).status, 429);
        assert.equal(new ExplainerError('EXPLAINER_PROVIDER_ERROR', 'The provider said no.').status, 502);
    });

    it('registers the params a code interpolates under names the dashboard’s `{param}` fields can use: never `count`, which the plural machinery owns', () => {
        for (const code of CODES) {
            const params = (ERROR_CODES[code] as { params?: readonly string[] }).params ?? [];
            assert.ok(!params.includes('count'), `${code} must not name a param "count"`);
        }
    });
});
