/**
 * `classifyOutcome`: every row of the data-model Outcome table, against the strings the comment path really writes.
 *
 * Where a real writer exists (`classifyDmError`, `metaFailure`) its output is used instead of a hand-typed copy, so a change to the
 * wording fails here instead of silently turning a designed skip into a red failure. The sentences `comments.ts` builds inline are
 * copied, and a test reads that file to hold each copy to the source.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { classifyDmError } from '../webhook/errors.js';
import { isExpectedFailure, summariseFailures } from './failureReasons.js';
import { metaFailure } from './instagram.js';
import { classifyOutcome, OUTCOMES, successRate } from './outcomes.js';

/** What a Graph API refusal looks like by the time it reaches `classifyDmError`. */
function metaError(code: number, message: string, prefix = 'Private Reply Failed') {
    return metaFailure(prefix, { response: { status: 400, data: { error: { code, message } } } });
}
const classified = (code: number, message: string) => classifyDmError(metaError(code, message));

// Verbatim from src/webhook/comments.ts (held to the source by the last describe block).
const RECIPIENT_CAP = 'Skipped: recipient already received an automated DM within 24 hours.';
const QUOTA_HOURLY = 'Skipped: hourly DM quota reached (181/180). Meta throttles automated sends at ~200/hr.';
const QUOTA_APP = 'Skipped: the app-wide Meta send budget is exhausted (1001/1000 this hour). That budget is shared by every account on this app, so nothing is necessarily wrong with this one.';
const PUBLIC_REPLY = ' Replied publicly with the link instead.';
const PUBLIC_REPLY_NEUTRAL = " Replied publicly with the link instead (in the neutral wording: the tenant's profile could not be read).";
const FALLBACK_FAILED = ' The public fallback reply failed too: Public Reply Failed: Permissions error (Code: 200)';

describe('classifyOutcome: the status decides', () => {
    it('SENT is delivered, whatever the log says about a later step', () => {
        assert.equal(classifyOutcome('SENT', null), 'delivered');
        // A DM that went out and then lost its public reply, or its second message, is still a delivered DM.
        assert.equal(classifyOutcome('SENT', 'Public reply failed: App missing permission.'), 'delivered');
        assert.equal(classifyOutcome('SENT', 'Message 2 of 3 failed to send (the first message was delivered): timeout'), 'delivered');
    });

    it('PENDING is pending, including a transient failure that is being retried', () => {
        assert.equal(classifyOutcome('PENDING', null), 'pending');
        assert.equal(classifyOutcome('PENDING', 'Retrying after a transient failure: Private Reply Failed: timeout'), 'pending');
        assert.equal(classifyOutcome('PENDING', "Retrying: the tenant's profile could not be read for the public reply."), 'pending');
    });

    it('USER_BLOCKED_DMS is blocked, and neutral: the person’s own privacy setting', () => {
        const blocked = classifyDmError(metaError(10903, 'User blocked'));
        assert.equal(blocked.status, 'USER_BLOCKED_DMS');
        assert.equal(classifyOutcome(blocked.status, blocked.error), 'blocked');
        assert.equal(classifyOutcome('USER_BLOCKED_DMS', null), 'blocked');
    });

    it('SKIPPED is by design, with or without a reason', () => {
        assert.equal(classifyOutcome('SKIPPED', null), 'by_design');
        assert.equal(classifyOutcome('SKIPPED', 'anything'), 'by_design');
    });
});

describe('classifyOutcome: a FAILED row is by design when the pipeline chose it', () => {
    it('the one-DM-per-24 h cap', () => {
        assert.equal(classifyOutcome('FAILED', RECIPIENT_CAP), 'by_design');
    });

    it('both send quotas, whatever counts they carry', () => {
        assert.equal(classifyOutcome('FAILED', QUOTA_HOURLY), 'by_design');
        assert.equal(classifyOutcome('FAILED', 'Skipped: hourly DM quota reached (999/180). Meta throttles automated sends at ~200/hr.'), 'by_design');
        assert.equal(classifyOutcome('FAILED', QUOTA_APP), 'by_design');
    });

    it('"already has a reply": Instagram’s -1 and Facebook’s 10900, as the pipeline words them', () => {
        const instagram = classified(-1, 'This comment already has a reply');
        const facebook = classified(10900, 'Activity already replied to');
        assert.equal(instagram.status, 'FAILED');
        assert.equal(facebook.status, 'FAILED');
        assert.equal(classifyOutcome(instagram.status, instagram.error), 'by_design');
        assert.equal(classifyOutcome(facebook.status, facebook.error), 'by_design');
    });

    it('10900 on a row written before the pipeline had its own sentence for it', () => {
        assert.equal(classifyOutcome('FAILED', 'Private Reply Failed: Activity already replied to (Code: 10900)'), 'by_design');
    });

    it('a DM that could not be delivered but was answered with a public reply, in both wordings', () => {
        const refused = classified(100, '(#100) Invalid parameter');
        assert.equal(refused.status, 'FAILED');
        assert.equal(classifyOutcome('FAILED', refused.error), 'actionable', 'the refusal alone is not by design: nobody was answered');
        assert.equal(classifyOutcome('FAILED', `${refused.error}${PUBLIC_REPLY}`), 'by_design');
        assert.equal(classifyOutcome('FAILED', `${refused.error}${PUBLIC_REPLY_NEUTRAL}`), 'by_design');
    });
});

describe('classifyOutcome: every other FAILED is actionable', () => {
    it('a dead token, a missing permission, a rate limit: what the owner has to fix', () => {
        for (const [code, message] of [[190, 'Error validating access token'], [200, 'Permissions error'], [613, 'Calls to this api have exceeded the rate limit'], [4, 'Application request limit reached']] as const) {
            const c = classified(code, message);
            assert.equal(c.status, 'FAILED', `${code}`);
            assert.equal(classifyOutcome(c.status, c.error), 'actionable', `${code}`);
        }
    });

    it('a bare code -1 is Graph’s generic unknown error, not "already has a reply"', () => {
        assert.equal(classifyOutcome('FAILED', 'Private Reply Failed: An unknown error occurred (Code: -1)'), 'actionable');
        const generic = classified(-1, 'An unknown error occurred');
        assert.equal(classifyOutcome(generic.status, generic.error), 'actionable');
    });

    it('the refusal whose public fallback failed too: the person got nothing at all', () => {
        const refused = classified(100, '(#100) Invalid parameter');
        assert.equal(classifyOutcome('FAILED', `${refused.error}${FALLBACK_FAILED}`), 'actionable');
    });

    it('a failure with no text at all is never assumed to be fine', () => {
        for (const log of [null, undefined, '', '   ']) assert.equal(classifyOutcome('FAILED', log), 'actionable', String(log));
        assert.equal(classifyOutcome('FAILED'), 'actionable');
    });

    it('a status nobody planned for is surfaced, not quietly counted', () => {
        for (const status of ['sent', 'DONE', '', null, undefined, 7]) assert.equal(classifyOutcome(status, null), 'actionable', String(status));
    });
});

describe('classifyOutcome: agrees with the failure panel', () => {
    it('isExpectedFailure is the same judgement the by_design class is built on', () => {
        const logs = [
            RECIPIENT_CAP, QUOTA_HOURLY, QUOTA_APP, classified(-1, 'This comment already has a reply').error,
            `${classified(100, 'x').error}${PUBLIC_REPLY}`, classified(190, 'Error validating access token').error, null,
        ];
        for (const log of logs) assert.equal(isExpectedFailure(log), classifyOutcome('FAILED', log) === 'by_design', String(log));
    });

    it('tags each reason with whether it was expected, and says how many of a mixed one were', () => {
        const at = new Date('2026-10-18T10:00:00Z');
        const refused = classified(100, '(#100) Invalid parameter').error;
        const { reasons } = summariseFailures([
            { error_log: QUOTA_HOURLY, count: 4, last_at: at },
            { error_log: RECIPIENT_CAP, count: 3, last_at: at },
            { error_log: classified(190, 'Error validating access token').error, count: 2, last_at: at },
            // One reason ('100'), two kinds of row: the public reply went out for three, not for one.
            { error_log: `${refused}${PUBLIC_REPLY}`, count: 3, last_at: at },
            { error_log: `${refused}${FALLBACK_FAILED}`, count: 1, last_at: at },
        ]);
        const by = Object.fromEntries(reasons.map((r) => [r.reason_code, r]));

        assert.deepEqual([by.quota_hourly!.expected, by.quota_hourly!.expected_count, by.quota_hourly!.count], [true, 4, 4]);
        assert.deepEqual([by.recipient_cap!.expected, by.recipient_cap!.expected_count], [true, 3]);
        assert.deepEqual([by['190']!.expected, by['190']!.expected_count], [false, 0]);
        assert.deepEqual([by['100']!.expected, by['100']!.expected_count, by['100']!.count], [false, 3, 4], 'mixed: not wholly expected, three of four were');
    });
});

describe('successRate', () => {
    it('is delivered ÷ (delivered + actionable): pending, by-design and blocked do not move it', () => {
        assert.equal(successRate({ delivered: 9, actionable: 1 }), 0.9);
        assert.equal(successRate({ delivered: 0, actionable: 3 }), 0);
        assert.equal(successRate({ delivered: 5, actionable: 0 }), 1);
    });

    it('is null, not 0 % and not 100 %, when nothing has been attempted', () => {
        assert.equal(successRate({ delivered: 0, actionable: 0 }), null);
    });
});

describe('OUTCOMES', () => {
    it('names the five classes of the data model', () => {
        assert.deepEqual([...OUTCOMES], ['delivered', 'by_design', 'actionable', 'pending', 'blocked']);
    });
});

describe('the strings copied above are the ones comments.ts writes', () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../webhook/comments.ts'), 'utf8');

    it('the 24 h cap and the hourly quota are in the source word for word', () => {
        assert.ok(source.includes(RECIPIENT_CAP), 'recipient cap');
        assert.ok(source.includes('Skipped: hourly DM quota reached ('), 'hourly quota prefix');
        assert.ok(source.includes('Meta throttles automated sends at ~200/hr.'), 'hourly quota suffix');
        assert.ok(source.includes('Skipped: the app-wide Meta send budget is exhausted ('), 'app quota prefix');
        assert.ok(source.includes('That budget is shared by every account on this app, so nothing is necessarily wrong with this one.'), 'app quota suffix');
    });

    it('the public-reply sentence is in the source, in both wordings', () => {
        assert.ok(source.includes('Replied publicly with the link instead'), 'public reply');
        assert.ok(source.includes('(in the neutral wording: the tenant\\\'s profile could not be read)'), 'neutral wording');
        assert.ok(source.includes('The public fallback reply failed too:'), 'fallback failed');
    });
});
