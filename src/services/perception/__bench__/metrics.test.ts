/**
 * The benchmark's arithmetic (`metrics.ts`): the rates, the percentiles, the cost per reply, the two counts of invented facts, the bar and the word error rate, each on numbers
 * small enough to check by hand. A skipped case is in no number, and an arm with no cases has no rate rather than a rate of zero.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ARM_LABELS, ARM_SUITE, BAR, barMet, dollars, percent, secs, summarizeArm, targetsOf, wordErrorRate } from './metrics.js';
import { ARM_IDS, type ArmCaseResult, type ArmId } from './types.js';

function result(over: Partial<ArmCaseResult> & { arm?: ArmId } = {}): ArmCaseResult {
    return {
        arm: 'meta', caseId: 'c', status: 'ran', note: null, understood: true, understoodWhy: null, action: 'answer', actionOk: true, actionWhy: null, seen: null, reply: 'hello', trace: null,
        invented: { draft: [], sent: [] }, failures: [], ms: 1000, usd: 0.01, tokensIn: 100, tokensOut: 50, calls: 2, judge: null, ...over,
    };
}

describe('summarizeArm', () => {
    it('counts what was understood and what was the expected action, over the cases that ran', () => {
        const s = summarizeArm('meta', 'm', [
            result({ caseId: 'a' }), result({ caseId: 'b', understood: false }), result({ caseId: 'c', actionOk: false }), result({ caseId: 'd', understood: false, actionOk: false }),
        ]);
        assert.deepEqual(s.understood, { n: 2, of: 4, pct: 50 });
        assert.deepEqual(s.expectedAction, { n: 2, of: 4, pct: 50 });
        assert.equal(s.cases, 4);
        assert.equal(s.label, ARM_LABELS.meta);
        assert.equal(s.suite, 'media');
    });

    it('rounds a rate to a tenth: 4 of 15 is 26.7', () => {
        const rows = Array.from({ length: 15 }, (_, i) => result({ caseId: `c${i}`, actionOk: i < 4 }));
        assert.equal(summarizeArm('meta', 'm', rows).expectedAction.pct, 26.7);
    });

    it('leaves a skipped case and another arm\'s case out of every number', () => {
        const s = summarizeArm('meta', 'm', [result({ caseId: 'a' }), result({ caseId: 'b', status: 'skipped', understood: null, actionOk: false }), result({ caseId: 'c', arm: 'today', actionOk: false })]);
        assert.equal(s.cases, 1);
        assert.deepEqual(s.expectedAction, { n: 1, of: 1, pct: 100 });
    });

    it('has no rate, not a rate of zero, for an arm with no cases', () => {
        const s = summarizeArm('voice', 'm', []);
        assert.deepEqual(s.understood, { n: 0, of: 0, pct: null });
        assert.equal(s.p50Ms, null);
        assert.equal(s.p90Ms, null);
        assert.equal(s.usdPerReply, null);
        assert.equal(s.judgeMean, null);
    });

    it('reads p50 and p90 by nearest rank, as the DM evaluation does: of ten values the fifth and the ninth', () => {
        const rows = Array.from({ length: 10 }, (_, i) => result({ caseId: `c${i}`, ms: (i + 1) * 1000 }));
        const s = summarizeArm('meta', 'm', rows);
        assert.equal(s.p50Ms, 5000);
        assert.equal(s.p90Ms, 9000);
        assert.equal(summarizeArm('meta', 'm', [result({ ms: 7000 })]).p90Ms, 7000);
    });

    it('divides the cost by the replies the customer was sent: a case that sent nothing costs and is not a reply', () => {
        const s = summarizeArm('meta', 'm', [result({ usd: 0.02 }), result({ usd: 0.01 }), result({ usd: 0.03, reply: '' })]);
        assert.equal(s.replies, 2);
        assert.equal(s.usd, 0.06);
        assert.equal(s.usdPerReply, 0.03);
        assert.equal(summarizeArm('meta', 'm', [result({ reply: '   ' })]).usdPerReply, null, 'no reply, no cost per reply');
    });

    it('counts invented facts twice: in the first draft, and in what the customer is sent', () => {
        const s = summarizeArm('meta', 'm', [
            result({ caseId: 'a', invented: { draft: ['no_invented_numbers: «299»'], sent: [] } }),
            result({ caseId: 'b', invented: { draft: ['no_model_links: «x.example»'], sent: ['no_model_links: «x.example»'] } }),
            result({ caseId: 'c' }),
        ]);
        assert.equal(s.inventedDraft, 2);
        assert.equal(s.inventedSent, 1);
    });

    it('collects every failure, with its case id', () => {
        const f = { caseId: 'a', arm: 'meta' as const, what: 'action', reason: 'it handed off' };
        const s = summarizeArm('meta', 'm', [result({ caseId: 'a', failures: [f] }), result({ caseId: 'b' })]);
        assert.deepEqual(s.failures, [f]);
    });

    it('takes the judge\'s mean over the replies it scored', () => {
        const j = (mean: number) => ({ mean, lowest: Math.floor(mean), notes: '' });
        assert.equal(summarizeArm('meta', 'm', [result({ judge: j(4) }), result({ judge: j(5) }), result()]).judgeMean, 4.5);
    });

    it('puts each arm in a suite, and every arm has a label', () => {
        assert.deepEqual(ARM_IDS.map((a) => ARM_SUITE[a]), ['media', 'media', 'voice', 'voice', 'memory', 'memory']);
        for (const a of ARM_IDS) assert.ok(ARM_LABELS[a]);
    });
});

describe('the bar', () => {
    const arm = (over: Partial<ArmCaseResult>[]): ReturnType<typeof summarizeArm> => summarizeArm('meta', 'm', over.map((o, i) => result({ caseId: `c${i}`, ...o })));

    it('is the spec\'s: 90% expected actions, no invented fact sent, p90 within 60 s (45 s for a voice note), three cents a reply', () => {
        assert.deepEqual(BAR, { expectedActionPct: 90, inventedFacts: 0, p90Ms: 60_000, voiceP90Ms: 45_000, usdPerReply: 0.03 });
    });

    it('is met exactly at the line, and missed a step over it', () => {
        const ten = (okCount: number): ArmCaseResult[] => Array.from({ length: 10 }, (_, i) => result({ caseId: `c${i}`, actionOk: i < okCount, ms: 60_000, usd: 0.03 }));
        assert.equal(targetsOf(summarizeArm('meta', 'm', ten(9))).every((t) => t.met), true, '9 of 10, 60 s, three cents: all on the line');
        const eight = targetsOf(summarizeArm('meta', 'm', ten(8)));
        assert.deepEqual(eight.filter((t) => !t.met).map((t) => t.id), ['action']);
        const slow = targetsOf(summarizeArm('meta', 'm', [result({ ms: 60_001 })]));
        assert.deepEqual(slow.filter((t) => !t.met).map((t) => t.id), ['p90']);
        const dear = targetsOf(summarizeArm('meta', 'm', [result({ usd: 0.0301 })]));
        assert.deepEqual(dear.filter((t) => !t.met).map((t) => t.id), ['cost']);
    });

    it('is missed by a single invented fact that reached a customer, and not by one the guard stopped', () => {
        assert.equal(targetsOf(arm([{ invented: { draft: ['x'], sent: [] } }])).find((t) => t.id === 'invented')!.met, true);
        assert.equal(targetsOf(arm([{ invented: { draft: ['x'], sent: ['x'] } }])).find((t) => t.id === 'invented')!.met, false);
    });

    it('holds a voice note to 45 seconds', () => {
        const slow = summarizeArm('voice', 'm', [result({ arm: 'voice', ms: 50_000 })]);
        assert.equal(targetsOf(slow).find((t) => t.id === 'p90')!.met, false);
        assert.equal(targetsOf(slow).find((t) => t.id === 'p90')!.goal, 'at most 45 s');
    });

    it('has no met bar for an arm with no cases, and no bar to meet for a run with no arm that answers a customer', () => {
        assert.equal(targetsOf(summarizeArm('meta', 'm', [])).some((t) => t.met), false);
        assert.equal(barMet([]), false);
        assert.equal(barMet([summarizeArm('today', 'm', [result({ arm: 'today' })])]), false, 'today is not held to the bar');
        assert.equal(barMet([summarizeArm('meta', 'm', [result()])]), true);
        assert.equal(barMet([summarizeArm('meta', 'm', [result()]), summarizeArm('voice', 'm', [result({ arm: 'voice', actionOk: false })])]), false, 'every arm that answers must meet it');
    });
});

describe('how a number is written', () => {
    it('shows seconds to a tenth, dollars to the precision the amount needs, and a rate without a trailing zero', () => {
        assert.equal(secs(null), '-');
        assert.equal(secs(24_149), '24.1 s');
        assert.equal(dollars(null), '-');
        assert.equal(dollars(0.0158), '$0.0158');
        assert.equal(dollars(0.5), '$0.50');
        assert.equal(percent({ n: 15, of: 15, pct: 100 }), '100%');
        assert.equal(percent({ n: 4, of: 15, pct: 26.7 }), '26.7%');
        assert.equal(percent({ n: 0, of: 0, pct: null }), '-');
    });
});

describe('wordErrorRate', () => {
    const w = (s: string): string[] => s.split(' ');

    it('is 0 for the same words, and counts a substitution, an insertion and a deletion each as one', () => {
        assert.equal(wordErrorRate(w('a b c d'), w('a b c d')), 0);
        assert.equal(wordErrorRate(w('a b c d'), w('a x c d')), 0.25);
        assert.equal(wordErrorRate(w('a b c d'), w('a b c d e')), 0.25);
        assert.equal(wordErrorRate(w('a b c d'), w('a b d')), 0.25);
    });

    it('can pass 1 when what was heard is much longer, and is 1 when nothing was heard', () => {
        assert.equal(wordErrorRate(w('a b'), w('x y z w')), 2);
        assert.equal(wordErrorRate(w('a b'), []), 1);
    });

    it('has no rate for a reference with no words', () => {
        assert.equal(wordErrorRate([], w('a b')), null);
    });
});
