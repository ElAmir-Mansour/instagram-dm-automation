/**
 * The report (`report.ts`): the numbers computed once and printed twice. Percentiles by nearest rank, the bar the plan sets, every failure
 * with its reason, and a markdown report that says when it is a dry run.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { percentile, renderMarkdown, renderTerminal, summarize } from './report.js';
import type { CaseOutcome, CheckResult, EvalRun, JudgeScore, TurnOutcome } from './types.js';

const ok = (name = 'route'): CheckResult => ({ name, pass: true, detail: '' });
const bad = (name: string, detail: string): CheckResult => ({ name, pass: false, detail });
const judged = (scores: Partial<JudgeScore['scores']>, over: Partial<JudgeScore> = {}): JudgeScore => ({ scores, notes: '', usd: 0.02, usage: { in: 2000, out: 50 }, ...over });

const turn = (over: Partial<TurnOutcome> = {}): TurnOutcome => ({
    index: 1, user: 'كم السعر؟', route: 'model', prefilter: 'pass', repaired: [], guardFallback: false, sent: { kind: 'model', text: 'السعر في الصفحة' }, paused: false,
    usage: { in: 1000, out: 100 }, usd: 0.01, priced: true, latencyMs: 2000, modelId: 'm-1', checks: [ok()], judge: judged({ tone: 5, helpfulness: 5, no_pressure: 5, right_recommendation: 5 }), ...over,
});
const caseOf = (id: string, turns: TurnOutcome[], over: Partial<CaseOutcome> = {}): CaseOutcome => ({ id, title: `title of ${id}`, fixture: 'owner-ar', writes: 'gulf', turns, skipped: 0, pass: true, ...over });
const runOf = (cases: CaseOutcome[], over: Partial<EvalRun> = {}): EvalRun => ({
    model: 'm-1', provider: 'anthropic', effort: 'low', judgeModel: 'j-1', cases, promptDigest: 'abc123abc123', casesDigest: 'def456def456', ...over,
});

describe('percentile', () => {
    it('is the value at that rank, counting from the smallest, and null for nothing', () => {
        assert.equal(percentile([], 50), null);
        assert.equal(percentile([7], 50), 7);
        assert.equal(percentile([7], 90), 7);
        assert.equal(percentile([1, 2, 3, 4], 50), 2);
        assert.equal(percentile([4, 1, 3, 2], 50), 2, 'order does not matter');
        assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
        assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 100), 10);
        assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0), 1);
        assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 51), 6);
    });

    it('does not reorder what it is given', () => {
        const values = [3, 1, 2];
        percentile(values, 50);
        assert.deepEqual(values, [3, 1, 2]);
    });
});

describe('summarize', () => {
    const run = runOf([
        caseOf('01-a', [turn({ latencyMs: 1000, usage: { in: 1000, out: 100, cacheRead: 500 }, usd: 0.01 })]),
        caseOf('02-b', [
            turn({ latencyMs: 3000, usage: { in: 2000, out: 200, cacheWrite: 300 }, usd: 0.02, repaired: ['next_action'], checks: [ok(), bad('no_invented_numbers', '«99 USD» is not in the data')], guardFallback: true,
                judge: judged({ tone: 2, helpfulness: 4 }, { notes: 'cold', usd: 0.03 }) }),
            turn({ index: 2, route: 'prefilter', prefilter: 'refund', usage: undefined, usd: undefined, latencyMs: undefined, judge: undefined, sent: { kind: 'handoff', text: 'x' } }),
        ], { pass: false }),
        caseOf('03-c', [turn({ latencyMs: 5000, usd: 0.03, judge: { error: 'overloaded' } })], { pass: false, skipped: 2 }),
    ]);
    const s = summarize(run);

    it('counts cases, passes, turns and the turns the model was asked about', () => {
        assert.deepEqual([s.cases, s.passed, s.turns, s.modelCalls], [3, 1, 4, 3]);
        assert.equal(s.passRate, 1 / 3);
    });

    it('sums tokens, cache and money, and keeps the judge\'s money apart from the model\'s', () => {
        assert.deepEqual([s.tokensIn, s.tokensOut, s.cacheRead, s.cacheWrite], [4000, 400, 500, 300]);
        assert.ok(Math.abs(s.usd - 0.06) < 1e-9);
        assert.ok(Math.abs(s.judgeUsd - 0.05) < 1e-9, '0.02 + 0.03: the judge that failed cost nothing the report can see');
    });

    it('takes latency over the model calls only, never the turns the filter decided', () => {
        assert.deepEqual([s.p50Ms, s.p90Ms], [3000, 5000]);
    });

    it('counts hard checks and their failures, repairs and guard refusals', () => {
        assert.equal(s.hardChecks, 5);
        assert.equal(s.hardFailures, 1);
        assert.equal(s.repairs, 1);
        assert.equal(s.guardFallbacks, 1);
    });

    it('averages what the judge scored, by criterion, and finds the lowest', () => {
        assert.equal(s.judged, 2);
        assert.equal(s.judgeFailures, 1);
        assert.equal(s.judgeMin, 2);
        assert.ok(Math.abs(s.judgeMean! - (5 * 4 + 2 + 4) / 6) < 1e-9);
        assert.equal(s.criterionMeans.tone, 3.5);
        assert.equal(s.criterionMeans.helpfulness, 4.5);
        assert.equal(s.criterionMeans.no_pressure, 5);
    });

    it('lists every failure with its reason: a check, a judge score under the floor, a judge that failed, a conversation cut short', () => {
        assert.deepEqual(s.failures.map((f) => [f.case, f.turn, f.what]), [
            ['02-b', 1, 'no_invented_numbers'], ['02-b', 1, 'judge'], ['03-c', 1, 'judge'], ['03-c', 2, 'skipped'],
        ]);
        assert.equal(s.failures[0]!.detail, '«99 USD» is not in the data');
        assert.equal(s.failures[1]!.detail, 'tone scored 2: cold');
        assert.equal(s.failures[2]!.detail, 'not scored: overloaded');
        assert.match(s.failures[3]!.detail, /2 later turns not run/);
    });

    it('the bar is not met, and each reason is named', () => {
        assert.equal(s.barMet, false);
        assert.deepEqual(s.barReasons, ['1 hard-check failure', 'a conversation stopped early', '1 reply not scored by the judge', 'a judged score of 2 is under 3']);
    });
});

describe('the bar (docs/DM_SALES_PLAN.md §11)', () => {
    const clean = (over: Partial<TurnOutcome> = {}) => runOf([caseOf('01-a', [turn(over)])]);

    it('is met when every hard check passes, the judge\'s mean is at least 4 and nothing is under 3', () => {
        const s = summarize(clean());
        assert.equal(s.barMet, true);
        assert.deepEqual(s.barReasons, []);
        assert.equal(summarize(clean({ judge: judged({ tone: 4, helpfulness: 4, no_pressure: 4, right_recommendation: 4 }) })).barMet, true, 'a mean of exactly 4');
    });

    it('is not met with a hard failure, however well the judge scored', () => {
        const s = summarize(clean({ checks: [bad('next_action', 'got handoff, expected send_link')] }));
        assert.equal(s.barMet, false);
        assert.deepEqual(s.barReasons, ['1 hard-check failure']);
    });

    it('is not met with a judge mean under 4, or one score under 3, and says which', () => {
        const mean = summarize(clean({ judge: judged({ tone: 3, helpfulness: 4, no_pressure: 4, right_recommendation: 4 }) }));
        assert.deepEqual(mean.barReasons, ['judge mean 3.75 is under 4']);
        const floor = summarize(clean({ judge: judged({ tone: 2, helpfulness: 5, no_pressure: 5, right_recommendation: 5 }) }));
        assert.deepEqual(floor.barReasons, ['a judged score of 2 is under 3']);
    });

    it('can never be met without a judge: the soft checks would be unscored, and unscored is not a pass', () => {
        const s = summarize(runOf([caseOf('01-a', [turn({ judge: undefined })])], { judgeModel: null }));
        assert.equal(s.barMet, false);
        assert.deepEqual(s.barReasons, ['soft checks not scored (no judge)']);
        assert.equal(s.judgeMean, null);
    });

    it('is not met when the judge was on and scored nothing', () => {
        const s = summarize(clean({ judge: undefined }));
        assert.equal(s.barMet, false);
        assert.deepEqual(s.barReasons, ['the judge scored nothing']);
    });

    it('is not met by a run with no cases', () => {
        const s = summarize(runOf([]));
        assert.equal(s.barMet, false);
        assert.equal(s.passRate, 0);
    });
});

describe('renderTerminal', () => {
    const good = runOf([caseOf('01-a', [turn()]), caseOf('02-b', [turn({ route: 'prefilter', prefilter: 'opt_out', usage: undefined, judge: undefined })])]);
    const failing = runOf([caseOf('01-a', [turn({ checks: [bad('no_invented_numbers', '«99 USD» is not in the data')] })], { pass: false })], { model: 'm-2' });

    it('prints one block for one model: its numbers, its cases, and no comparison table', () => {
        const text = renderTerminal([good]);
        assert.match(text, /^== m-1 \(anthropic, effort low\), judge j-1 ==/);
        assert.match(text, /^cases {5}2, passed 2 \(100\.0%\)/m);
        assert.match(text, /^bar {7}MET$/m);
        assert.match(text, /^latency {3}p50 2\.0 s, p90 2\.0 s \(over 1 model calls/m);
        assert.match(text, /^tokens {4}in 1,000, out 100$/m);
        assert.match(text, /^cost {6}\$0\.0100 for the model \+ \$0\.0200 for the judge = \$0\.0300; \$0\.0100 a model call$/m);
        assert.match(text, /^judge {5}mean 5\.00, lowest 5; tone 5\.00/m);
        assert.match(text, /01-a +gulf +owner-ar +1 +model +PASS/);
        assert.match(text, /02-b +gulf +owner-ar +1 +filter:opt_out +PASS/);
        assert.ok(!text.includes('failures:'));
        assert.ok(!/hard fails/.test(text), 'one model: nothing to compare');
    });

    it('prints a comparison first for several models, and each failure under its model', () => {
        const text = renderTerminal([good, failing]);
        const [comparison] = text.split('\n\n');
        assert.match(comparison!, /^model +passed +hard fails +judge mean +p50 +p90 +tokens in\/out +model \$ +judge \$ +bar/);
        assert.match(comparison!, /m-1 +2\/2 \(100\.0%\) +0 .* MET/);
        assert.match(comparison!, /m-2 +0\/1 \(0\.0%\) +1 .* NOT MET/);
        assert.match(text, /bar {7}NOT MET: 1 hard-check failure/);
        assert.match(text, /failures:\n {2}01-a turn 1 - no_invented_numbers: «99 USD» is not in the data/);
    });

    it('says a model had no judge, and leaves the judge line out', () => {
        const text = renderTerminal([runOf([caseOf('01-a', [turn({ judge: undefined })])], { judgeModel: null })]);
        assert.match(text, /^== m-1 \(anthropic, effort low\), no judge ==/);
        assert.ok(!/^judge {5}/m.test(text));
        assert.match(text, /NOT MET: soft checks not scored/);
    });
});

describe('renderMarkdown', () => {
    const meta = { at: new Date('2026-10-14T12:00:00Z'), command: 'npx tsx scripts/eval-dm-sales.mts --model m-1', stub: false, cacheSystem: true };
    const failing = runOf([caseOf('01-a', [turn({
        user: 'a | b', sent: { kind: 'unsure', text: 'سأتأكد' }, guardFallback: true, rawText: 'السعر 99 دولار',
        checks: [bad('no_invented_numbers', '«99» is not in the data')], judge: undefined,
    })], { pass: false, title: 'a | b' })]);

    it('opens with what was run: when, how, on what prompts and cases, and the bar', () => {
        const md = renderMarkdown([runOf([caseOf('01-a', [turn()])])], meta);
        assert.match(md, /^# DM sales evaluation\n/);
        assert.match(md, /- Run: 2026-10-14T12:00:00\.000Z/);
        assert.match(md, /- Command: `npx tsx scripts\/eval-dm-sales\.mts --model m-1`/);
        assert.match(md, /- Cases: 1 \(cases digest `def456def456`\)/);
        assert.match(md, /digest `abc123abc123`/);
        assert.match(md, /System prompt cache: on/);
        assert.match(md, /the judge's mean is at least 4, and no judged score is under 3/);
        assert.ok(!md.includes('Dry run'));
        assert.ok(md.endsWith('\n') && !md.endsWith('\n\n') && !/\n{3,}/.test(md));
    });

    it('says in its first lines that a dry run is one, so nobody picks a model by it', () => {
        const md = renderMarkdown([runOf([caseOf('01-a', [turn()])])], { ...meta, stub: true, cacheSystem: false });
        assert.match(md, /^# DM sales evaluation\n\n> \*\*Dry run\.\*\* The answers are canned/);
        assert.match(md, /System prompt cache: off/);
    });

    it('has a comparison for several models and a section for each', () => {
        const md = renderMarkdown([runOf([caseOf('01-a', [turn()])]), runOf([caseOf('01-a', [turn()])], { model: 'm-2' })], meta);
        assert.match(md, /^## Comparison$/m);
        assert.match(md, /^## m-1 \(anthropic, effort low\), judge j-1$/m);
        assert.match(md, /^## m-2 \(anthropic, effort low\), judge j-1$/m);
        const one = renderMarkdown([runOf([caseOf('01-a', [turn()])])], meta);
        assert.ok(!one.includes('## Comparison'));
    });

    it('lists the failures with their reasons, and each conversation with what was said and what the customer was sent', () => {
        const md = renderMarkdown([failing], meta);
        assert.match(md, /### Failures\n\n- `01-a` turn 1, \*\*no_invented_numbers\*\*: «99» is not in the data/);
        assert.match(md, /<details><summary><code>01-a<\/code> a \| b: FAIL<\/summary>/);
        assert.match(md, /> Customer: a \| b/);
        assert.match(md, /> Bot \(unsure, after the guard refused the model\): سأتأكد/);
        assert.match(md, /> Model wrote \(not sent\): السعر 99 دولار/);
        assert.match(md, /- FAIL `no_invented_numbers`: «99» is not in the data/);
        assert.match(md, /<\/details>/);
    });

    it('escapes a pipe in a table cell, so a title cannot break the table', () => {
        const md = renderMarkdown([runOf([caseOf('01-a', [turn()], { title: 'a | b' })])], meta);
        for (const line of md.split('\n').filter((l) => l.startsWith('| ') && l.includes('`01-a`'))) {
            assert.equal(line.replace(/\\\|/g, '').split('|').length, 10, line);
        }
    });

    it('says "No failures." for a clean run, and shows the judge\'s scores and notes under a turn', () => {
        const md = renderMarkdown([runOf([caseOf('01-a', [turn({ judge: judged({ tone: 4, helpfulness: 5 }, { notes: 'a little formal' }) })])])], meta);
        assert.match(md, /^No failures\.$/m);
        assert.match(md, /- judge: tone 4, helpfulness 5; a little formal/);
    });

    it('shows a model call that failed, and the turns that never ran', () => {
        const md = renderMarkdown([runOf([caseOf('01-a', [turn({ usage: undefined, usd: undefined, latencyMs: undefined, judge: undefined, error: { kind: 'timeout', message: 'slow' }, sent: { kind: 'none', text: '' }, checks: [bad('model_answer', 'x')] })], { pass: false, skipped: 2 })])], meta);
        assert.match(md, /- model call failed \(timeout\): slow/);
        assert.match(md, /> Bot \(none\): \(nothing sent\)/);
        assert.match(md, /2 later turns not run\./);
    });
});
