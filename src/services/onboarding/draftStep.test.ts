/**
 * The draft state machine's decisions (P24), by value: what a row in each state leads to, the lease, the deadline and the retry policy.
 * No database, no clock, no network: `drafts.test.ts` runs the same decisions against the in-memory table.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyBusiness, emptyVoice, okBusiness, okVoice } from './fixtures/draftAnswers.js';
import {
    ACTIVE_STATUSES, answerProblem, BACKOFF_MS, CALL_TIMEOUT_MS, callTimeoutMs, DEADLINE_MS, decideAfterCalls, decideAfterFetch, DRAFT_STATUSES, FETCH_PHASE_MS, hasBudgetFor,
    isAdvanceable, isActiveStatus, isTerminalStatus, LEASE_MS, MAX_AGE_MS, MAX_ATTEMPTS, MAX_BAD_OUTPUT, mayRetryCall, MIN_DRAFT_BUDGET_MS, MIN_FETCH_BUDGET_MS,
    nextDraftStep, retryPlan, SAVE_MARGIN_MS, SWEEP_DEADLINE_MS, type CallState, type StepRow,
} from './draftStep.js';

const NOW = Date.UTC(2026, 9, 14, 9, 0, 0);
const at = (ms: number): Date => new Date(NOW + ms);
const MIN = 60_000;

const row = (over: Partial<StepRow> = {}): StepRow => ({
    status: 'queued', attempts: 0, created_at: at(-10_000), next_attempt_at: null, lease_until: null, lease_owner: null, hasSources: false, ...over,
});

describe('the timings are the plan\'s', () => {
    it('a call times out at 150 s, an invocation works to 270 s, holds the draft for 290 s, and the sweep stops at 280 s', () => {
        assert.equal(CALL_TIMEOUT_MS, 150_000);
        assert.equal(DEADLINE_MS, 270_000);
        assert.equal(LEASE_MS, 290_000);
        assert.equal(SWEEP_DEADLINE_MS, 280_000);
        assert.equal(FETCH_PHASE_MS, 25_000);
    });

    it('the lease outlasts the deadline, so a second caller cannot take over while the first is still inside its time', () => {
        assert.ok(LEASE_MS > DEADLINE_MS);
        assert.ok(LEASE_MS > SWEEP_DEADLINE_MS);
    });

    it('three tries, a minute and then five minutes apart', () => {
        assert.equal(MAX_ATTEMPTS, 3);
        assert.deepEqual([...BACKOFF_MS], [60_000, 300_000]);
    });

    it('the whole retry schedule fits the age a draft is allowed to reach', () => {
        const worst = DEADLINE_MS * MAX_ATTEMPTS + BACKOFF_MS.reduce((a, b) => a + b, 0);
        assert.ok(worst < MAX_AGE_MS + 5 * MIN, `three full invocations and both waits take ${worst} ms; a draft is given up at ${MAX_AGE_MS}`);
    });
});

describe('statuses', () => {
    it('are the six the table allows, three of them active', () => {
        assert.deepEqual([...DRAFT_STATUSES], ['queued', 'fetching', 'drafting', 'ready', 'failed', 'superseded']);
        assert.deepEqual([...ACTIVE_STATUSES], ['queued', 'fetching', 'drafting']);
        for (const s of ACTIVE_STATUSES) assert.ok(isActiveStatus(s) && !isTerminalStatus(s), s);
        for (const s of ['ready', 'failed', 'superseded']) assert.ok(isTerminalStatus(s) && !isActiveStatus(s), s);
    });
});

describe('nextDraftStep: every state of a row', () => {
    for (const status of ['ready', 'failed', 'superseded']) {
        it(`${status}: nothing to do, whatever else the row says`, () => {
            assert.deepEqual(nextDraftStep(row({ status, lease_until: at(MIN), lease_owner: 'x', created_at: at(-2 * MAX_AGE_MS), attempts: 9 }), NOW), { kind: 'terminal' });
        });
    }

    it('queued: fetch', () => assert.deepEqual(nextDraftStep(row({ status: 'queued' }), NOW), { kind: 'fetch' }));
    it('fetching (a lost invocation, or a retry that is due): fetch again', () => assert.deepEqual(nextDraftStep(row({ status: 'fetching' }), NOW), { kind: 'fetch' }));
    it('drafting with its sources stored: draft, and never fetch again', () => assert.deepEqual(nextDraftStep(row({ status: 'drafting', hasSources: true }), NOW), { kind: 'draft' }));
    it('drafting with no sources (a row someone edited by hand): back to fetching', () => assert.deepEqual(nextDraftStep(row({ status: 'drafting', hasSources: false }), NOW), { kind: 'fetch' }));

    it('advanceable is exactly the states where a caller would do something', () => {
        assert.equal(isAdvanceable({ kind: 'fetch' }), true);
        assert.equal(isAdvanceable({ kind: 'draft' }), true);
        assert.equal(isAdvanceable({ kind: 'expire' }), true);
        assert.equal(isAdvanceable({ kind: 'exhausted' }), true);
        assert.equal(isAdvanceable({ kind: 'terminal' }), false);
        assert.equal(isAdvanceable({ kind: 'wait', why: 'leased', untilMs: NOW }), false);
        assert.equal(isAdvanceable({ kind: 'wait', why: 'backoff', untilMs: NOW }), false);
    });
});

describe('nextDraftStep: the lease', () => {
    it('held by somebody else and not run out: wait until it does', () => {
        assert.deepEqual(nextDraftStep(row({ lease_until: at(100_000), lease_owner: 'other' }), NOW), { kind: 'wait', why: 'leased', untilMs: NOW + 100_000 });
    });

    it('run out (its holder died or was too slow): the draft may be taken', () => {
        assert.deepEqual(nextDraftStep(row({ lease_until: at(-1), lease_owner: 'dead' }), NOW), { kind: 'fetch' });
        assert.deepEqual(nextDraftStep(row({ lease_until: at(0), lease_owner: 'dead' }), NOW), { kind: 'fetch' }, 'a lease that ends exactly now is over');
    });

    it('the caller\'s own lease does not block it', () => {
        assert.deepEqual(nextDraftStep(row({ lease_until: at(100_000), lease_owner: 'me' }), NOW, 'me'), { kind: 'fetch' });
        assert.deepEqual(nextDraftStep(row({ lease_until: at(100_000), lease_owner: 'me' }), NOW, 'someone-else'), { kind: 'wait', why: 'leased', untilMs: NOW + 100_000 });
        assert.equal(nextDraftStep(row({ lease_until: at(100_000), lease_owner: 'me' }), NOW).kind, 'wait', 'with no owner given, a held lease is somebody else\'s');
    });
});

describe('nextDraftStep: back-off, age and spent attempts', () => {
    it('a retry that is not due yet waits, and says until when', () => {
        assert.deepEqual(nextDraftStep(row({ attempts: 1, next_attempt_at: at(MIN) }), NOW), { kind: 'wait', why: 'backoff', untilMs: NOW + MIN });
    });

    it('a retry that is due is taken', () => {
        assert.deepEqual(nextDraftStep(row({ attempts: 1, next_attempt_at: at(0) }), NOW), { kind: 'fetch' });
        assert.deepEqual(nextDraftStep(row({ attempts: 2, status: 'drafting', hasSources: true, next_attempt_at: at(-1) }), NOW), { kind: 'draft' });
    });

    it('a draft older than 30 minutes is given up', () => {
        assert.deepEqual(nextDraftStep(row({ created_at: at(-MAX_AGE_MS - 1) }), NOW), { kind: 'expire' });
        assert.deepEqual(nextDraftStep(row({ created_at: at(-MAX_AGE_MS) }), NOW), { kind: 'fetch' }, 'exactly 30 minutes is not yet over');
    });

    it('three attempts used is the end, even if every try failed in a way that "may pass"', () => {
        assert.deepEqual(nextDraftStep(row({ attempts: 3 }), NOW), { kind: 'exhausted' });
        assert.deepEqual(nextDraftStep(row({ attempts: 2 }), NOW), { kind: 'fetch' });
    });

    it('age and attempts are decided BEFORE the lease and the back-off: a draft nobody can finish can still end', () => {
        assert.equal(nextDraftStep(row({ created_at: at(-MAX_AGE_MS - 1), lease_until: at(MIN), lease_owner: 'x', next_attempt_at: at(MIN) }), NOW).kind, 'expire');
        assert.equal(nextDraftStep(row({ attempts: 3, lease_until: at(MIN), lease_owner: 'x', next_attempt_at: at(MIN) }), NOW).kind, 'exhausted');
    });
});

describe('retryPlan', () => {
    it('counts the failed try and says when the next is due: a minute, then five', () => {
        assert.deepEqual(retryPlan(0, NOW), { attempts: 1, nextAttemptAt: NOW + 60_000 });
        assert.deepEqual(retryPlan(1, NOW), { attempts: 2, nextAttemptAt: NOW + 300_000 });
    });

    it('the third failed try is the last: no plan', () => {
        assert.equal(retryPlan(2, NOW), null);
        assert.equal(retryPlan(7, NOW), null);
    });
});

const call = (over: Partial<CallState> = {}): CallState => ({ errors: [], gaveUp: false, ...over });
const fail = (kind: CallState['errors'][number]['kind'], retryable: boolean, message: string = kind) => ({ kind, retryable, message });

describe('decideAfterCalls', () => {
    it('both answered: finish, not partial', () => {
        assert.deepEqual(decideAfterCalls({ voice: call({ answer: {} }), business: call({ answer: {} }) }, 0, NOW), { kind: 'finish', partial: false });
    });

    it('one answered and the other failed in a way that may pass: retry only the other (never one that is already paid for)', () => {
        const d = decideAfterCalls({ voice: call({ answer: { ok: 1 } }), business: call({ errors: [fail('timeout', true)] }) }, 0, NOW);
        assert.deepEqual(d, { kind: 'retry', missing: ['business'], attempts: 1, nextAttemptAt: NOW + 60_000 });
    });

    it('both failed in a way that may pass: retry both', () => {
        const d = decideAfterCalls({ voice: call({ errors: [fail('server', true)] }), business: call({ errors: [fail('rate', true)] }) }, 1, NOW);
        assert.deepEqual(d, { kind: 'retry', missing: ['voice', 'business'], attempts: 2, nextAttemptAt: NOW + 300_000 });
    });

    it('one answered and the other cannot be fixed (a refusal): finish partial, at once', () => {
        assert.deepEqual(decideAfterCalls({ voice: call({ answer: {} }), business: call({ errors: [fail('refusal', false)], gaveUp: true }) }, 0, NOW), { kind: 'finish', partial: true });
    });

    it('one answered and the tries ran out on the other: finish partial, because what landed is worth showing', () => {
        assert.deepEqual(decideAfterCalls({ voice: call({ answer: {} }), business: call({ errors: [fail('timeout', true)] }) }, 2, NOW), { kind: 'finish', partial: true });
    });

    it('nothing answered and nothing can be fixed: fail, with the most telling error (a missing key before a refusal)', () => {
        const d = decideAfterCalls({
            voice: call({ errors: [fail('refusal', false, 'refused')], gaveUp: true }),
            business: call({ errors: [fail('no_provider', false, 'no key')], gaveUp: true }),
        }, 0, NOW);
        assert.deepEqual(d, { kind: 'fail', errorKind: 'no_provider', message: 'no key' });
    });

    it('nothing answered and the tries ran out: fail with what the last try said, and not retried again', () => {
        const d = decideAfterCalls({ voice: call({ errors: [fail('timeout', true, 'slow')] }), business: call({ errors: [fail('timeout', true, 'slow')] }) }, 2, NOW);
        assert.deepEqual(d, { kind: 'fail', errorKind: 'timeout', message: 'slow' });
    });

    it('a call given up on is not retried even while the other one is', () => {
        const d = decideAfterCalls({ voice: call({ errors: [fail('bad_request', false)], gaveUp: true }), business: call({ errors: [fail('timeout', true)] }) }, 0, NOW);
        assert.deepEqual(d, { kind: 'retry', missing: ['business'], attempts: 1, nextAttemptAt: NOW + 60_000 });
    });

    it('priority: a key problem is reported before a quota, a budget before a refusal, a refusal before a timeout', () => {
        const pick = (a: CallState['errors'][number], b: CallState['errors'][number]) => (decideAfterCalls({ voice: call({ errors: [a], gaveUp: true }), business: call({ errors: [b], gaveUp: true }) }, 0, NOW) as { errorKind: string }).errorKind;
        assert.equal(pick(fail('auth', false), fail('quota', false)), 'auth');
        assert.equal(pick(fail('refusal', false), fail('budget', false)), 'budget');
        assert.equal(pick(fail('max_tokens', false), fail('bad_request', false)), 'max_tokens');
    });
});

describe('mayRetryCall: a malformed answer is retried once, not for ever', () => {
    it('a first bad_output may be retried; a second may not', () => {
        assert.equal(MAX_BAD_OUTPUT, 2);
        assert.equal(mayRetryCall(call({ errors: [fail('bad_output', true)] })), true);
        assert.equal(mayRetryCall(call({ errors: [fail('bad_output', true), fail('bad_output', true)] })), false);
    });

    it('other retryable kinds are not limited by it, and a final one never is', () => {
        assert.equal(mayRetryCall(call({ errors: [fail('bad_output', true), fail('timeout', true)] })), true);
        assert.equal(mayRetryCall(call({ errors: [fail('refusal', false)] })), false);
        assert.equal(mayRetryCall(call()), false, 'a call that has not failed has nothing to retry');
    });

    it('decideAfterCalls honours it: two malformed answers in a row end the call', () => {
        const d = decideAfterCalls({ voice: call({ answer: {} }), business: call({ errors: [fail('bad_output', true), fail('bad_output', true)] }) }, 1, NOW);
        assert.deepEqual(d, { kind: 'finish', partial: true });
    });
});

describe('decideAfterFetch', () => {
    it('any source that gave something is enough: a source that failed on its own never fails the draft', () => {
        assert.deepEqual(decideAfterFetch(1, true, 0, NOW), { kind: 'proceed' });
        assert.deepEqual(decideAfterFetch(12, false, 2, NOW), { kind: 'proceed' });
    });

    it('nothing read, and a failure that may pass: retry (a minute, then five)', () => {
        assert.deepEqual(decideAfterFetch(0, true, 0, NOW), { kind: 'retry', attempts: 1, nextAttemptAt: NOW + 60_000 });
        assert.deepEqual(decideAfterFetch(0, true, 1, NOW), { kind: 'retry', attempts: 2, nextAttemptAt: NOW + 300_000 });
    });

    it('nothing read and the tries are used: no source', () => {
        assert.deepEqual(decideAfterFetch(0, true, 2, NOW), { kind: 'fail', errorKind: 'no_source' });
    });

    it('nothing read and nothing a later try could fix: no source, at once', () => {
        assert.deepEqual(decideAfterFetch(0, false, 0, NOW), { kind: 'fail', errorKind: 'no_source' });
    });
});

describe('the budget of one invocation', () => {
    it('a fetch needs its 25 s phase and time to write; a draft needs a real minute for its calls', () => {
        assert.ok(MIN_FETCH_BUDGET_MS > FETCH_PHASE_MS);
        assert.ok(MIN_DRAFT_BUDGET_MS >= 60_000);
        const deadline = NOW + DEADLINE_MS;
        assert.equal(hasBudgetFor('fetch', deadline, NOW), true);
        assert.equal(hasBudgetFor('draft', deadline, NOW), true);
        assert.equal(hasBudgetFor('fetch', deadline, deadline - MIN_FETCH_BUDGET_MS + 1), false);
        assert.equal(hasBudgetFor('draft', deadline, deadline - MIN_DRAFT_BUDGET_MS + 1), false);
        assert.equal(hasBudgetFor('draft', deadline, deadline - MIN_DRAFT_BUDGET_MS), true);
    });

    it('a call gets its own 150 s, or what is left less the time to save', () => {
        const deadline = NOW + DEADLINE_MS;
        assert.equal(callTimeoutMs(deadline, NOW), CALL_TIMEOUT_MS);
        assert.equal(callTimeoutMs(deadline, deadline - 100_000), 100_000 - SAVE_MARGIN_MS);
        assert.equal(callTimeoutMs(deadline, deadline - 160_000), CALL_TIMEOUT_MS);
        assert.ok(callTimeoutMs(deadline, deadline + 5_000) >= 1_000, 'never zero or negative: the caller validates it is positive');
    });
});

describe('answerProblem: the shape a call\'s answer must have', () => {
    const voice = okVoice();
    const business = okBusiness();

    it('a complete answer has none, for either call', () => {
        assert.equal(answerProblem('voice', voice), null);
        assert.equal(answerProblem('business', business), null);
        assert.equal(answerProblem('voice', emptyVoice()), null, 'complete and empty is shape-valid: whether it says anything is validateDraft\'s `usable`');
        assert.equal(answerProblem('business', emptyBusiness()), null, 'and a creator who sells nothing answers the business call exactly so');
    });

    it('anything that is not an object holding every section is malformed', () => {
        for (const bad of [undefined, null, 0, 'text', true, [], [voice], {}, { identity: {} }]) assert.match(answerProblem('voice', bad) ?? '', /not a JSON object|left out/, JSON.stringify(bad));
        assert.match(answerProblem('business', {}) ?? '', /left out offers, dm_faq/);
    });

    it('names what is missing, at most six', () => {
        const { pillars: _p, domain: _d, ...rest } = voice;
        assert.equal(answerProblem('voice', rest), 'The model\'s answer left out pillars, domain.');
        assert.equal((answerProblem('voice', {}) ?? '').split(',').length, 6);
    });

    it('the business answer is not judged by the voice call\'s sections, nor the reverse', () => {
        assert.notEqual(answerProblem('voice', business), null);
        assert.notEqual(answerProblem('business', voice), null);
    });
});

describe('decideAfterCalls: a draft that ends reports its LATEST try', () => {
    it('two timeouts and then an answer that said nothing: it ended on the empty answer, not on a timeout it already outlived', () => {
        const state = (): CallState => ({ errors: [fail('timeout', true, 'slow'), fail('timeout', true, 'slow'), fail('bad_output', true, 'said nothing')], gaveUp: false });
        const d = decideAfterCalls({ voice: state(), business: state() }, 2, NOW);
        assert.deepEqual(d, { kind: 'fail', errorKind: 'bad_output', message: 'said nothing' });
    });
});
