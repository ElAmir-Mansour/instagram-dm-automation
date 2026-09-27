/**
 * "Why DMs fail" (A5): how a FAILED row's `error_log` becomes a reason.
 *
 * The strings here are produced by the real writers wherever one exists — `classifyDmError`,
 * `metaFailure` — rather than typed out, so a change to the wording the pipeline writes fails
 * this file instead of silently dropping that reason into "text:".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyDmError } from '../webhook/errors.js';
import { metaFailure } from './instagram.js';
import {
    FAILURE_REASON_TOP, failureReasonCode, normaliseFailureLine, summariseFailures, TEXT_REASON_PREFIX,
} from './failureReasons.js';

/** What a Graph API refusal looks like by the time it reaches `classifyDmError`. */
function metaError(code: number, message: string, prefix = 'Private Reply Failed') {
    return metaFailure(prefix, { response: { status: 400, data: { error: { code, message } } } });
}
const logged = (code: number, message: string) => classifyDmError(metaError(code, message)).error;

describe('failureReasonCode', () => {
    it('reads the Meta code the pipeline writes into error_log', () => {
        assert.equal(failureReasonCode(logged(190, 'Error validating access token')), '190');
        assert.equal(failureReasonCode(logged(200, 'Permissions error')), '200');
        assert.equal(failureReasonCode(logged(613, 'Calls to this api have exceeded the rate limit')), '613');
        assert.equal(failureReasonCode(logged(4, 'Application request limit reached')), '4');
        assert.equal(failureReasonCode(logged(10, 'Application does not have permission')), '10');
        // errors.ts writes this one without the colon.
        assert.equal(failureReasonCode(classifyDmError(metaError(10903, 'blocked')).error), '10903');
    });

    it('recognises the pipeline’s own sentences before any code', () => {
        // Code 100's sentence carries the code too, but the sentence is the reason.
        assert.equal(failureReasonCode(logged(100, '(#100) Invalid parameter')), '100');
        // The one-private-reply refusal: Facebook says 10900, Instagram -1. One reason, not two.
        assert.equal(failureReasonCode(logged(10900, 'Activity already replied to')), 'already_replied');
        assert.equal(failureReasonCode(logged(-1, 'This comment already has a reply')), 'already_replied');
    });

    it('names the three send caps, which make no Meta call and carry no code', () => {
        // Verbatim from src/webhook/comments.ts.
        assert.equal(failureReasonCode('Skipped: recipient already received an automated DM within 24 hours.'), 'recipient_cap');
        assert.equal(failureReasonCode('Skipped: hourly DM quota reached (181/180). Meta throttles automated sends at ~200/hr.'), 'quota_hourly');
        assert.equal(
            failureReasonCode('Skipped: the app-wide Meta send budget is exhausted (1001/1000 this hour). That budget is shared by every account on this app, so nothing is necessarily wrong with this one.'),
            'quota_app'
        );
    });

    it('takes the DM’s code, not the public fallback’s that failed after it', () => {
        const dm = logged(190, 'Error validating access token');
        const withFallback = `${dm} The public fallback reply failed too: ${metaError(200, 'Permissions error', 'Public Reply Failed').message}`;
        assert.equal(failureReasonCode(withFallback), '190');
        assert.equal(failureReasonCode(`${logged(100, 'x')} Replied publicly with the link instead.`), '100');
    });

    it('groups anything else by its first line, numbers and spacing made uniform', () => {
        const a = failureReasonCode('Instagram media processing failed with status: 3.\nDetail: ...');
        const b = failureReasonCode('Instagram media   processing failed with status: 12.');
        assert.equal(a, `${TEXT_REASON_PREFIX}Instagram media processing failed with status: #.`);
        assert.equal(a, b, 'one sentence is one reason');
        // `(Code: N/A)` is not a code.
        assert.ok(failureReasonCode('Private Reply Failed: socket hang up (Code: N/A)').startsWith(TEXT_REASON_PREFIX));
    });

    it('calls an empty error_log unknown', () => {
        for (const raw of [null, undefined, '', '   ', 42]) assert.equal(failureReasonCode(raw), 'unknown');
    });

    it('clips the normalised line', () => {
        assert.equal(normaliseFailureLine('x'.repeat(300)).length, 120);
        assert.equal(normaliseFailureLine('\n'), '');
    });
});

describe('summariseFailures', () => {
    const at = (iso: string) => new Date(iso);

    it('folds text groups into reasons, most frequent first, with the latest sample', () => {
        const rows = [
            { error_log: 'Skipped: hourly DM quota reached (181/180). Meta throttles automated sends at ~200/hr.', count: 4, last_at: at('2026-09-26T10:00:00Z'), total: 16 },
            { error_log: logged(190, 'Error validating access token'), count: 3, last_at: at('2026-09-20T10:00:00Z'), total: 16 },
            { error_log: 'Skipped: hourly DM quota reached (190/180). Meta throttles automated sends at ~200/hr.', count: 2, last_at: at('2026-09-27T09:00:00Z'), total: 16 },
            { error_log: logged(190, 'Session has expired'), count: 5, last_at: at('2026-09-22T10:00:00Z'), total: 16 },
            { error_log: null, count: 2, last_at: at('2026-09-01T10:00:00Z'), total: 16 },
        ];
        const { total, reasons } = summariseFailures(rows);

        assert.equal(total, 16);
        assert.deepEqual(reasons.map((r) => [r.reason_code, r.count]), [['190', 8], ['quota_hourly', 6], ['unknown', 2]]);
        assert.match(reasons[0]!.sample!, /Session has expired/, 'the most recent text behind the reason');
        assert.equal(reasons[0]!.last_at, '2026-09-22T10:00:00.000Z');
        assert.match(reasons[1]!.sample!, /190\/180/);
        assert.equal(reasons[1]!.last_at, '2026-09-27T09:00:00.000Z');
    });

    it('keeps the top six, breaking a tie by the most recent', () => {
        const rows = Array.from({ length: 9 }, (_, i) => ({
            error_log: `Private Reply Failed: x (Code: ${1000 + i})`, count: 1, last_at: at(`2026-09-${String(10 + i).padStart(2, '0')}T00:00:00Z`),
        }));
        const { total, reasons } = summariseFailures(rows);

        assert.equal(FAILURE_REASON_TOP, 6);
        assert.equal(reasons.length, 6);
        assert.deepEqual(reasons.map((r) => r.reason_code), ['1008', '1007', '1006', '1005', '1004', '1003']);
        assert.equal(total, 9, 'no window total: the sum of what was counted');
    });

    it('reads nothing into an empty window', () => {
        assert.deepEqual(summariseFailures([]), { total: 0, reasons: [] });
    });

    it('never reports a total below what it counted', () => {
        const { total } = summariseFailures([{ error_log: 'a', count: 5, last_at: null, total: 2 }]);
        assert.equal(total, 5);
    });
});
