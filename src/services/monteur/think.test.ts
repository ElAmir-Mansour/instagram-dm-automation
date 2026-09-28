/**
 * Claude on the Mac (MONTEUR.md §6.3): the schema the CLI gets, the tries of one request and what
 * each state leads to, the answer as the steps read it, and the worker's result as it is stored.
 * The pool answers by SQL; Gemini is stood in for only to prove it is never reached.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { GeminiSchema } from '../studio/generate.js';
import { setModelCaller, type CallModel } from '../studio/generate.js';
import { STUDIO_JOB_KINDS } from '../studio/jobs.js';
import { setLogSink } from '../../utils/log.js';
import { ANALYST_PURPOSE, LESSONS_SCHEMA, THINKING_RUN } from './analyst.js';
import { COPY_SCHEMA } from './copy.js';
import { EDITOR_SCHEMA } from './editor.js';
import { ask, emptyCost } from './model.js';
import { PICK_SCHEMA } from './pick.js';
import { MAX_THINK_OUTPUT_CHARS, parseMonteurThinkResult } from './results.js';
import { installFakeDb, type FakeDb } from './testDb.js';
import {
    clipsThinkKey, flattenTurns, lessonsThinkKey, MAX_THINK_TRIES, nextThinkStep, readThinkAnswer, sourceThinkKey,
    THINK_BACKOFF_MINUTES, THINK_ENQUEUE_SQL, THINK_FAILED, THINK_MODEL, THINK_STALE_ERROR, THINK_STALE_MINUTES,
    ThinkExhausted, thinkRoute, ThinkWaiting, toJsonSchema, type ThinkTry,
} from './think.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '66666666-6666-4666-8666-666666666666';
const MIN = 60;

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

/** Every node of a converted schema, depth first. */
function nodes(schema: unknown): Record<string, unknown>[] {
    if (!schema || typeof schema !== 'object') return [];
    const s = schema as Record<string, unknown>;
    const props = s.properties && typeof s.properties === 'object' ? Object.values(s.properties as object) : [];
    return [s, ...nodes(s.items), ...props.flatMap(nodes)];
}

describe('toJsonSchema — Gemini’s responseSchema as JSON Schema for claude --json-schema', () => {
    it('lower-cases every type, drops propertyOrdering and the array bounds, and closes every object', () => {
        const schema: GeminiSchema = {
            type: 'OBJECT',
            properties: {
                clips: {
                    type: 'ARRAY', maxItems: 5, minItems: 1, description: 'the clips',
                    items: {
                        type: 'OBJECT',
                        properties: { n: { type: 'INTEGER' }, kind: { type: 'STRING', enum: ['a', 'b'] }, ok: { type: 'BOOLEAN' }, x: { type: 'NUMBER' } },
                        required: ['n'],
                        propertyOrdering: ['n', 'kind'],
                    },
                },
            },
            required: ['clips'],
            propertyOrdering: ['clips'],
        };
        assert.deepEqual(toJsonSchema(schema), {
            type: 'object',
            properties: {
                clips: {
                    type: 'array', description: 'the clips',
                    items: {
                        type: 'object',
                        properties: { n: { type: 'integer' }, kind: { type: 'string', enum: ['a', 'b'] }, ok: { type: 'boolean' }, x: { type: 'number' } },
                        required: ['n'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['clips'],
            additionalProperties: false,
        });
    });

    it('holds for the four real schemas: the pick, the copy, the Editor and the Analyst', () => {
        for (const [name, schema] of [['pick', PICK_SCHEMA], ['copy', COPY_SCHEMA], ['edit', EDITOR_SCHEMA], ['analyst', LESSONS_SCHEMA]] as const) {
            const all = nodes(toJsonSchema(schema));
            assert.ok(all.length > 3, name);
            for (const n of all) {
                assert.match(String(n.type), /^(object|array|string|integer|number|boolean)$/, `${name}: ${String(n.type)}`);
                assert.ok(!('propertyOrdering' in n) && !('maxItems' in n) && !('minItems' in n), name);
                if (n.type === 'object') assert.equal(n.additionalProperties, false, name);
                else assert.ok(!('additionalProperties' in n), name);
            }
        }
    });

    it('leaves the Gemini schema it was given alone', () => {
        const before = JSON.stringify(PICK_SCHEMA);
        toJsonSchema(PICK_SCHEMA);
        assert.equal(JSON.stringify(PICK_SCHEMA), before);
    });
});

describe('flattenTurns', () => {
    it('one turn is its text; a repair round is the prompt, the previous answer, then what to fix', () => {
        assert.equal(flattenTurns([{ role: 'user', text: 'Pick.' }]), 'Pick.');
        assert.equal(
            flattenTurns([{ role: 'user', text: 'Pick.' }, { role: 'model', text: '{"clips":[]}' }, { role: 'user', text: 'Fix L9.' }]),
            'Pick.\n\nYour previous answer:\n{"clips":[]}\n\nFix L9.',
        );
    });
});

describe('the request ids', () => {
    it('a source’s are per pick attempt; the Analyst’s per run; the Editor’s name its clips', () => {
        assert.equal(thinkRoute({ creatorId: TENANT, key: sourceThinkKey(SOURCE, 2) }, 'monteur.pick', 'pick')!.request, `source/${SOURCE}/a2/monteur.pick`);
        assert.equal(thinkRoute(undefined, 'monteur.pick', 'pick'), undefined, 'no route: Gemini');
        const a = clipsThinkKey('k', [{ start: 1, end: 20 }, { start: 30, end: 55 }]);
        assert.match(a, /^k\/clips-[0-9a-f]{10}$/);
        assert.equal(clipsThinkKey('k', [{ start: 1, end: 20 }, { start: 30, end: 55 }]), a, 'stable');
        assert.notEqual(clipsThinkKey('k', [{ start: 30, end: 55 }]), a, 'another set of clips is another request');
    });

    it('THINKING_RUN finds a run by the very request its call is queued under', () => {
        const request = thinkRoute({ creatorId: TENANT, key: lessonsThinkKey('RUN') }, ANALYST_PURPOSE, 'analyst')!.request;
        const sql = THINKING_RUN.replace(/\s+/g, ' ');
        const m = sql.match(/'([^']*)' \|\| l\.id::text \|\| '([^']*)'/);
        assert.ok(m, sql);
        assert.equal(`${m![1]}RUN${m![2]}`, request);
        assert.match(sql, /j\.kind = 'monteur_think'/);
    });
});

const tryRow = (over: Partial<ThinkTry>): ThinkTry => ({
    id: 'j', status: 'pending', result: null, error: null, try: 1, quiet_s: 0, since_s: 0, ...over,
});

describe('nextThinkStep — what each state of a request leads to', () => {
    it('no try: ask for try 1', () => {
        assert.deepEqual(nextThinkStep([]), { kind: 'ask', try: 1 });
    });

    it('an open try waits while it shows life in the last 20 minutes, and is stale after', () => {
        assert.equal(THINK_STALE_MINUTES, 20);
        assert.equal(nextThinkStep([tryRow({ status: 'pending', quiet_s: 19 * MIN })]).kind, 'wait');
        assert.equal(nextThinkStep([tryRow({ status: 'claimed', quiet_s: 19 * MIN })]).kind, 'wait');
        assert.equal(nextThinkStep([tryRow({ status: 'pending', quiet_s: 20 * MIN })]).kind, 'stale');
        assert.equal(nextThinkStep([tryRow({ status: 'claimed', quiet_s: 45 * MIN })]).kind, 'stale');
    });

    it('a done try is the answer', () => {
        const done = tryRow({ status: 'done', result: { output: {} } });
        assert.deepEqual(nextThinkStep([done]), { kind: 'answer', try: done });
    });

    it('a failed try is asked again after 10 minutes, then 30, then 2 hours', () => {
        assert.deepEqual(THINK_BACKOFF_MINUTES, [10, 30, 120]);
        const failed = (n: number, since: number) => Array.from({ length: n }, (_, i) => tryRow({ status: 'failed', try: n - i, since_s: since, error: `e${n - i}` }));
        assert.equal(nextThinkStep(failed(1, 9 * MIN)).kind, 'wait');
        assert.deepEqual(nextThinkStep(failed(1, 10 * MIN)), { kind: 'ask', try: 2 });
        assert.equal(nextThinkStep(failed(2, 29 * MIN)).kind, 'wait');
        assert.deepEqual(nextThinkStep(failed(2, 30 * MIN)), { kind: 'ask', try: 3 });
        assert.equal(nextThinkStep(failed(3, 119 * MIN)).kind, 'wait');
        assert.deepEqual(nextThinkStep(failed(3, 120 * MIN)), { kind: 'ask', try: 4 });
    });

    it('the fourth failed try stops it, with the last reason, however long ago', () => {
        assert.equal(MAX_THINK_TRIES, 4);
        const four = [4, 3, 2, 1].map((n) => tryRow({ status: 'failed', try: n, since_s: 99_999, error: `reason ${n}` }));
        assert.deepEqual(nextThinkStep(four), { kind: 'exhausted', error: `${THINK_FAILED}reason 4` });
        assert.equal(THINK_FAILED, 'Claude on the Mac didn\'t answer: ');
    });
});

describe('readThinkAnswer — the answer as the steps read it', () => {
    it('takes structured output as it is, and parses text as Gemini’s is parsed', () => {
        const usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, output_tokens: 300 };
        assert.deepEqual(readThinkAnswer({ output: { clips: [1] }, model: 'claude-opus-5-5', usage }), {
            ok: true, output: { clips: [1] }, model: 'claude-opus-5-5', tokensIn: 1015, tokensOut: 300,
        });
        const text = readThinkAnswer({ output: '{"clips":[2]}', model: 'm', usage: {} });
        assert.ok(text.ok && JSON.stringify(text.output) === '{"clips":[2]}');
    });

    it('text that is not JSON, or no answer at all, is unusable, and says why', () => {
        const bad = readThinkAnswer({ output: 'Sure! Here are the clips', model: 'm' });
        assert.ok(!bad.ok && /not valid JSON.*Sure! Here are the clips/.test(bad.error));
        assert.equal(readThinkAnswer(null).ok, false);
        assert.equal(readThinkAnswer({ output: null }).ok, false);
    });
});

// ─── think() and ask() against the queue ────────────────────────────────────────────────

describe('think — the queue, from the sweep’s side', () => {
    let db: FakeDb;
    let tries: ThinkTry[];
    let gemini: number;
    let previousCaller: CallModel;
    const route = { creatorId: TENANT, request: `source/${SOURCE}/a1/monteur.pick`, step: 'pick' as const };
    const req = {
        purpose: 'monteur.pick', system: 'You pick.', turns: [{ role: 'user' as const, text: 'L1 hello' }], schema: PICK_SCHEMA,
        temperature: 0.4, thinkingBudget: 1024, maxOutputTokens: 8192, capMs: 120_000, think: route,
    };

    beforeEach(() => {
        db = installFakeDb();
        tries = [];
        gemini = 0;
        previousCaller = setModelCaller(async () => {
            gemini += 1;
            throw new Error('Gemini was reached');
        });
        db.routes.push(
            [/^SELECT id, status, result, error, \(payload->>'try'\)::int AS try/, () => ({ rows: tries.map((t) => ({ ...t })) })],
            [/^INSERT INTO studio_jobs \(creator_id, kind, payload\) VALUES \(\$1, 'monteur_think'/, () => ({ rows: [{ id: 'job-new' }] })],
            [/^UPDATE studio_jobs SET status = 'failed'/, (p) => {
                const t = tries.find((x) => x.id === p[0] && (p[2] as string[]).includes(x.status));
                if (t) Object.assign(t, { status: 'failed', error: p[1], since_s: 0 });
                return { rows: [], rowCount: t ? 1 : 0 };
            }],
        );
    });
    afterEach(() => {
        db.restore();
        setModelCaller(previousCaller);
    });

    const queued = () => db.ran(/^INSERT INTO studio_jobs/).map((s) => ({ creator: s.params[0], payload: JSON.parse(s.params[1]) }));

    it('queues try 1 with the whole call — the Opus id, the converted schema, one prompt — and waits', async () => {
        await assert.rejects(ask(req, Date.now() + 100_000, emptyCost()), ThinkWaiting);
        const [job] = queued();
        assert.equal(job!.creator, TENANT);
        assert.deepEqual(job!.payload, {
            request: route.request, try: 1, step: 'pick', purpose: 'monteur.pick', model: THINK_MODEL,
            system: 'You pick.', user: 'L1 hello', schema: toJsonSchema(PICK_SCHEMA),
        });
        assert.equal(THINK_MODEL, 'claude-opus-5-5');
        assert.match(THINK_ENQUEUE_SQL.replace(/\s+/g, ' '), /ON CONFLICT DO NOTHING/, 'two drains asking at once queue it once');
        assert.equal(gemini, 0);
    });

    it('asks nothing new while a try is open and alive, and has no deadline to fit', async () => {
        tries = [tryRow({ status: 'claimed', quiet_s: 30 })];
        await assert.rejects(ask(req, Date.now() - 1, emptyCost()), (e: unknown) => e instanceof ThinkWaiting && /with Claude on the Mac/.test(e.message));
        assert.equal(queued().length, 0);
        assert.equal(gemini, 0);
    });

    it('returns a done try’s answer and records Claude’s model and tokens as the cost', async () => {
        tries = [tryRow({
            status: 'done',
            result: { output: { topic: 't', clips: [] }, model: 'claude-opus-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 95, output_tokens: 40 } },
        })];
        const cost = emptyCost();
        assert.deepEqual(await ask(req, Date.now() + 100_000, cost), { topic: 't', clips: [] });
        assert.deepEqual(cost, { model: 'claude-opus-5-5', tokens_in: 100, tokens_out: 40, thinking: 0, calls: 1 });
        assert.equal(queued().length, 0);
        assert.equal(gemini, 0);
    });

    it('fails a try gone quiet for 20 minutes, and waits the backoff before asking again — never Gemini', async () => {
        tries = [tryRow({ id: 'j1', status: 'pending', quiet_s: 21 * MIN })];
        await assert.rejects(ask(req, Date.now() + 100_000, emptyCost()), (e: unknown) => e instanceof ThinkWaiting && /try 2 in 10 min/.test(e.message));
        const [fail] = db.ran(/^UPDATE studio_jobs SET status = 'failed'/);
        assert.deepEqual(fail!.params, ['j1', THINK_STALE_ERROR, ['pending', 'claimed']]);
        assert.equal(queued().length, 0, 'the new try waits its 10 minutes');
        assert.equal(gemini, 0);
    });

    it('asks for the next try once the backoff is over', async () => {
        tries = [tryRow({ id: 'j1', status: 'failed', since_s: 11 * MIN, error: 'plan limit' })];
        await assert.rejects(ask(req, Date.now() + 100_000, emptyCost()), ThinkWaiting);
        assert.equal(queued()[0]!.payload.try, 2);
        assert.equal(gemini, 0);
    });

    it('fails a done try whose answer is not JSON, as a failed try', async () => {
        tries = [tryRow({ id: 'j1', status: 'done', result: { output: 'I cannot help with that', model: 'm' } })];
        await assert.rejects(ask(req, Date.now() + 100_000, emptyCost()), ThinkWaiting);
        const [fail] = db.ran(/^UPDATE studio_jobs SET status = 'failed'/);
        assert.equal(fail!.params[0], 'j1');
        assert.match(fail!.params[1], /not valid JSON/);
        assert.deepEqual(fail!.params[2], ['done']);
        assert.equal(gemini, 0);
    });

    it('stops after the fourth failed try, with its reason', async () => {
        tries = [4, 3, 2, 1].map((n) => tryRow({ id: `j${n}`, status: 'failed', try: n, since_s: 999 * MIN, error: n === 4 ? 'You have hit your limit' : 'x' }));
        await assert.rejects(ask(req, Date.now() + 100_000, emptyCost()),
            (e: unknown) => e instanceof ThinkExhausted && e.message === `${THINK_FAILED}You have hit your limit`);
        assert.equal(queued().length, 0);
        assert.equal(gemini, 0);
    });

    it('without a route, ask is Gemini’s, as before', async () => {
        const { think: _think, ...gem } = req;
        await assert.rejects(ask(gem, Date.now() + 100_000, emptyCost()), /Gemini was reached/);
        assert.equal(gemini, 1);
        assert.equal(db.statements.length, 0, 'and the queue is not touched');
    });
});

// ─── The worker's result ────────────────────────────────────────────────────────────────

describe('parseMonteurThinkResult — what completeJob stores', () => {
    it('keeps output, model and the four token counts', () => {
        assert.deepEqual(parseMonteurThinkResult({
            output: { clips: [] }, model: 'claude-opus-5-5',
            usage: { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 2, service_tier: 'standard' },
        }), {
            output: { clips: [] }, model: 'claude-opus-5-5',
            usage: { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 2 },
        });
        assert.equal(parseMonteurThinkResult({ output: '{"a":1}', model: 'm' }).output, '{"a":1}', 'text is kept for the sweep to parse');
    });

    it('refuses a result without an answer or a model, or with an answer too big to be one', () => {
        for (const bad of [null, 'x', {}, { output: null, model: 'm' }, { output: 5, model: 'm' }, { output: {}, model: '' }, { output: {}, model: 'm', usage: 3 },
            { output: 'x'.repeat(MAX_THINK_OUTPUT_CHARS + 1), model: 'm' }]) {
            assert.throws(() => parseMonteurThinkResult(bad), (e: unknown) => (e as { status?: number }).status === 400, JSON.stringify(bad)?.slice(0, 80));
        }
    });
});

describe('migration v28', () => {
    const sql = fs.readFileSync(new URL('../../config/migration_v28_monteur_think.sql', import.meta.url), 'utf8');

    it('re-creates the kind CHECK with exactly the kinds the queue knows, monteur_think among them', () => {
        const list = sql.match(/ADD CONSTRAINT studio_jobs_kind_check CHECK \(kind IN \(([^)]*)\)\)/);
        assert.ok(list, 'the constraint is re-added');
        const kinds = [...list![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
        assert.deepEqual(kinds, [...STUDIO_JOB_KINDS].sort());
        assert.ok(kinds.includes('monteur_think'));
    });

    it('is idempotent: the constraint dropped IF EXISTS first, the index IF NOT EXISTS under a new name', () => {
        assert.ok(sql.indexOf('DROP CONSTRAINT IF EXISTS studio_jobs_kind_check') < sql.indexOf('ADD CONSTRAINT studio_jobs_kind_check'));
        assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_jobs_think_try/);
        assert.match(sql, /WHERE kind = 'monteur_think' AND NOT \(payload \? 'retired'\)/, 'a retired try leaves room for a new round');
    });
});
