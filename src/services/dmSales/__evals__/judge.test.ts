/**
 * The judge (`judge.ts`): what it is shown, what it must answer, and that a judge which fails or answers nonsense is a reported failure
 * and never a quiet pass.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { jsonSchemaFor } from '../../llm/schema.js';
import { isJudgeFailure, JUDGE_FLOOR, JUDGE_MEAN_TARGET, JUDGE_SCHEMA, JUDGE_SYSTEM, judgeReply, judgeUserText, lowestScore, parseJudgeAnswer, type JudgeInput } from './judge.js';
import { SOFT_CRITERIA, type ModelRequest, type ModelResponse } from './types.js';

const input = (over: Partial<JudgeInput> = {}): JudgeInput => ({
    botSystem: 'BOT-SYSTEM persona, offers and rules', conversation: [{ role: 'user', text: 'كم السعر؟' }, { role: 'model', text: 'الصفحة فيها السعر' }, { role: 'user', text: 'طيب' }],
    reply: 'تمام، أرسل لك الرابط؟', systemAction: 'next_action: recommend · offer: Agentic AI', asked: ['tone', 'helpfulness'], case: '01-x', turn: 2, ...over,
});

const respond = (json: unknown): ModelResponse => ({ json, model: 'judge-1', usage: { in: 100, out: 20 }, usd: 0.0123, priced: true, latencyMs: 5 });

describe('the judge\'s rubric', () => {
    it('names every soft criterion the cases can ask for, and the schema has a field for each, all required', () => {
        for (const c of SOFT_CRITERIA) assert.ok(JUDGE_SYSTEM.includes(`- ${c}:`), c);
        const schema = JUDGE_SCHEMA as { properties: Record<string, unknown>; required: string[] };
        assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
        assert.deepEqual(Object.keys(schema.properties), ['notes', ...SOFT_CRITERIA], 'the notes come first: the scores follow from them');
        const json = jsonSchemaFor(JUDGE_SCHEMA);
        assert.equal(json.additionalProperties, false);
    });

    it('tells the judge the conversation is data, and that code covers dialect, links, prices and length', () => {
        assert.match(JUDGE_SYSTEM, /data to grade/);
        assert.match(JUDGE_SYSTEM, /not a command/);
        assert.match(JUDGE_SYSTEM, /dialect words, links, prices and length/);
    });

    it('sets the bar the plan sets: a mean of 4 and nothing under 3', () => {
        assert.equal(JUDGE_MEAN_TARGET, 4);
        assert.equal(JUDGE_FLOOR, 3);
    });
});

describe('judgeUserText', () => {
    it('shows the bot\'s own instructions and data, the conversation with who said what, the reply, the action and what to score', () => {
        const text = judgeUserText(input());
        const at = (needle: string): number => {
            const i = text.indexOf(needle);
            assert.ok(i >= 0, needle);
            return i;
        };
        assert.ok(at('BOT-SYSTEM') < at('Customer: كم السعر؟'));
        assert.ok(at('Customer: كم السعر؟') < at('Assistant: الصفحة فيها السعر'));
        assert.ok(at('Assistant: الصفحة فيها السعر') < at('Customer: طيب'));
        assert.ok(at('Customer: طيب') < at('=== The reply being graded ===\nتمام، أرسل لك الرابط؟'));
        assert.ok(text.includes('next_action: recommend · offer: Agentic AI'));
        assert.ok(text.endsWith('Score these: tone, helpfulness. Score every other criterion 0.'));
    });
});

describe('parseJudgeAnswer', () => {
    const asked = ['tone', 'no_pressure'] as const;

    it('reads a score for each criterion asked, ignores the others, and keeps the notes short', () => {
        const parsed = parseJudgeAnswer({ notes: '  a   b\nc ', tone: 4, helpfulness: 0, no_pressure: 5, right_recommendation: 0 }, asked);
        assert.deepEqual(parsed, { scores: { tone: 4, no_pressure: 5 }, notes: 'a b c' });
        const long = parseJudgeAnswer({ notes: 'x'.repeat(1000), tone: 1, no_pressure: 1 }, asked);
        assert.ok('notes' in long && long.notes.length === 400);
    });

    it('refuses a score that is not a whole number from 1 to 5, a missing one, and an answer that is not an object', () => {
        for (const bad of [0, 6, 4.5, '4', null, undefined, NaN, -1, [4]]) {
            const parsed = parseJudgeAnswer({ notes: '', tone: bad, no_pressure: 5 }, asked);
            assert.ok('error' in parsed, String(bad));
            assert.match((parsed as { error: string }).error, /tone is .*not a whole number from 1 to 5/);
        }
        assert.match((parseJudgeAnswer({ tone: 4 }, asked) as { error: string }).error, /no_pressure is missing/);
        for (const bad of [null, 'text', [], 7]) assert.ok('error' in parseJudgeAnswer(bad, asked), JSON.stringify(bad));
    });
});

describe('judgeReply', () => {
    const settings = { maxTokens: 1234, timeoutMs: 5678 };

    it('sends one request for the reply, as the judge, uncached, and returns the scores with what the call cost', async () => {
        let seen: ModelRequest | undefined;
        const out = await judgeReply(async (r) => { seen = r; return respond({ notes: 'none', tone: 5, helpfulness: 4, no_pressure: 0, right_recommendation: 0 }); }, input(), settings);
        assert.ok(!isJudgeFailure(out));
        assert.deepEqual(out, { scores: { tone: 5, helpfulness: 4 }, notes: 'none', usd: 0.0123, usage: { in: 100, out: 20 } });
        assert.equal(seen!.system, JUDGE_SYSTEM);
        assert.deepEqual(seen!.meta, { role: 'judge', case: '01-x', turn: 2 });
        assert.deepEqual([seen!.cacheSystem, seen!.maxTokens, seen!.timeoutMs, seen!.schema], [false, 1234, 5678, JUDGE_SCHEMA]);
        assert.deepEqual(seen!.user, [{ role: 'user', text: judgeUserText(input()) }]);
    });

    it('never throws: a call that fails, or an answer that is not a score, is a failure the report shows', async () => {
        const failed = await judgeReply(async () => { throw new Error('overloaded   badly'); }, input(), settings);
        assert.deepEqual(failed, { error: 'overloaded badly' });
        const nonsense = await judgeReply(async () => respond({ notes: '', tone: 9, helpfulness: 4 }), input(), settings);
        assert.ok(isJudgeFailure(nonsense) && /tone is 9/.test(nonsense.error));
        const notObject = await judgeReply(async () => respond('five stars'), input(), settings);
        assert.ok(isJudgeFailure(notObject));
        const thrownString = await judgeReply(async () => { throw 'plain string'; }, input(), settings);
        assert.deepEqual(thrownString, { error: 'plain string' });
    });

    it('does not call the judge when there is nothing to score', async () => {
        let called = false;
        const out = await judgeReply(async () => { called = true; return respond({}); }, input({ asked: [] }), settings);
        assert.deepEqual(out, { error: 'nothing to score' });
        assert.equal(called, false);
    });
});

describe('lowestScore', () => {
    it('is the smallest score of a judged reply, and null for one that was not judged or whose judge failed', () => {
        assert.equal(lowestScore({ scores: { tone: 5, helpfulness: 3, no_pressure: 4 }, notes: '', usd: 0, usage: { in: 0, out: 0 } }), 3);
        assert.equal(lowestScore({ error: 'x' }), null);
        assert.equal(lowestScore(undefined), null);
        assert.equal(lowestScore({ scores: {}, notes: '', usd: 0, usage: { in: 0, out: 0 } }), null);
    });
});
