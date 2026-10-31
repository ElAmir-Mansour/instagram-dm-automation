/**
 * How the benchmark calls a model (`caller.ts`), with the network mocked: that a call goes to Meta's own address with the key in the header and nowhere else, at the effort and with
 * the limit the product uses; that what it cost is read from what the response said it used (cached tokens at the cached rate); that a failure is recorded and thrown as it came; that
 * only the purposes it was told to route are routed, all of them to Meta; and that no key is ever in a body, a message or a table.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setAiCaller, type AiGenerateArgs } from '../../aiProviders/generate.js';
import { DEFAULT_PRICES } from '../../llm/cost.js';
import { AiError } from '../../llm/errors.js';
import type { LlmSchema } from '../../llm/schema.js';
import { setLogSink } from '../../../utils/log.js';
import { perceive } from '../perceive.js';
import { billingOf, Ledger, makeAiCaller, makeEvalCaller, redactKeys, scrubKey } from './caller.js';
import { ANTHROPIC_KEY, anthropicAnswer, chatAnswer, hasMedia, META_KEY, messagesOf, scriptedFetch } from './testSupport.js';

setLogSink(() => {});

const SCHEMA: LlmSchema = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] };
const request = (over: Record<string, unknown> = {}) => ({
    system: 'You answer.', user: [{ role: 'user' as const, text: 'hello' }], schema: SCHEMA, maxTokens: 1000, timeoutMs: 20_000, cacheSystem: true,
    meta: { role: 'sales' as const, case: 'c', turn: 1 }, ...over,
});

describe('makeEvalCaller: the sales turn\'s draft', () => {
    it('sends the request to Meta\'s own address with the key in the header, at low effort, with the room Muse needs to think, and no key anywhere else', async () => {
        const { fetch, requests } = scriptedFetch(() => chatAnswer({ ok: true }));
        const ledger = new Ledger();
        const caller = makeEvalCaller({ provider: 'meta', model: 'muse-spark-1.3', effort: 'low', role: 'reply', apiKey: META_KEY, ledger, fetchImpl: fetch });
        const out = await caller(request());
        assert.deepEqual(out.json, { ok: true });
        assert.equal(requests.length, 1);
        const r = requests[0]!;
        assert.equal(r.url, 'https://api.meta.ai/v1/chat/completions');
        assert.equal(r.authorization, `Bearer ${META_KEY}`);
        assert.equal(r.body.model, 'muse-spark-1.3');
        assert.equal(r.body.reasoning_effort, 'low');
        assert.equal(r.body.max_tokens, 4000, 'raised to what a model that thinks first needs: a floor, never lowered');
        assert.equal(r.body.response_format.type, 'json_schema');
        assert.equal(r.body.response_format.json_schema.strict, true);
        assert.deepEqual(messagesOf(r).map((m) => m.role), ['system', 'user']);
        assert.equal(r.rawBody!.includes(META_KEY), false, 'the key is in the header only');
        assert.equal(r.url.includes(META_KEY), false);
    });

    it('keeps a limit above the floor as it was given', async () => {
        const { fetch, requests } = scriptedFetch(() => chatAnswer({ ok: true }));
        const caller = makeEvalCaller({ provider: 'meta', model: 'muse-spark-1.3', effort: 'low', role: 'reply', apiKey: META_KEY, ledger: new Ledger(), fetchImpl: fetch });
        await caller(request({ maxTokens: 9000 }));
        assert.equal(requests[0]!.body.max_tokens, 9000);
    });

    it('prices a call from what the response says it used: the prompt, the answer, and the cached part of the prompt at the cached rate', async () => {
        const { fetch } = scriptedFetch(() => chatAnswer({ ok: true }, { prompt: 10_000, completion: 1_000, cached: 4_000 }));
        const ledger = new Ledger();
        const caller = makeEvalCaller({ provider: 'meta', model: 'muse-spark-1.3', effort: 'low', role: 'reply', apiKey: META_KEY, ledger, fetchImpl: fetch });
        const out = await caller(request());
        // 6,000 at $1.25, 4,000 at 0.12 of that, 1,000 at $4.25, per million.
        const expected = (6_000 * 1.25 + 4_000 * 1.25 * 0.12 + 1_000 * 4.25) / 1e6;
        assert.equal(out.usd, Math.round(expected * 1e9) / 1e9);
        assert.equal(out.priced, true);
        assert.deepEqual(out.usage, { in: 6_000, out: 1_000, cacheRead: 4_000 });
        assert.ok(out.latencyMs >= 0);
        assert.equal(ledger.calls.length, 1);
        assert.deepEqual([ledger.calls[0]!.role, ledger.calls[0]!.provider, ledger.calls[0]!.ok, ledger.calls[0]!.tokensIn, ledger.calls[0]!.tokensOut, ledger.calls[0]!.cacheRead], ['reply', 'meta', true, 6_000, 1_000, 4_000]);
    });

    it('records a failed call too and throws what came: a refused key is an auth error with no key in its message', async () => {
        const { fetch } = scriptedFetch(() => ({ status: 401, json: { error: { message: `bad key ${META_KEY}`, code: 401 } } }));
        const ledger = new Ledger();
        const caller = makeEvalCaller({ provider: 'meta', model: 'muse-spark-1.3', effort: 'low', role: 'reply', apiKey: META_KEY, ledger, fetchImpl: fetch });
        await assert.rejects(caller(request()), (err: unknown) => err instanceof AiError && err.kind === 'auth' && !err.message.includes(META_KEY));
        assert.deepEqual(ledger.calls.map((c) => [c.ok, c.usd]), [[false, 0]]);
    });

    it('charges a call that was billed and cut off (the thinking used the limit): the tokens go to the ledger with the error', async () => {
        const body = { model: 'muse-spark-1.3', choices: [{ finish_reason: 'length', message: { content: null } }], usage: { prompt_tokens: 2000, completion_tokens: 4000 } };
        const { fetch } = scriptedFetch(() => ({ json: body }));
        const ledger = new Ledger();
        const caller = makeEvalCaller({ provider: 'meta', model: 'muse-spark-1.3', effort: 'low', role: 'reply', apiKey: META_KEY, ledger, fetchImpl: fetch });
        await assert.rejects(caller(request()), (err: unknown) => err instanceof AiError && err.kind === 'max_tokens');
        assert.equal(ledger.calls[0]!.ok, false);
        assert.equal(ledger.calls[0]!.tokensOut, 4000);
        assert.ok(ledger.calls[0]!.usd > 0, 'a cut-off answer is still paid for');
    });

    it('sends a judge to Anthropic\'s address with Anthropic\'s key, and never the Meta key (each key goes to its own host)', async () => {
        const { fetch, requests } = scriptedFetch((r) => (r.host === 'api.anthropic.com' ? anthropicAnswer({ ok: true }) : chatAnswer({ ok: true })));
        const ledger = new Ledger();
        const judge = makeEvalCaller({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium', role: 'judge', apiKey: ANTHROPIC_KEY, ledger, fetchImpl: fetch });
        const sales = makeEvalCaller({ provider: 'meta', model: 'muse-spark-1.3', effort: 'low', role: 'reply', apiKey: META_KEY, ledger, fetchImpl: fetch });
        await judge(request({ cacheSystem: false, meta: { role: 'judge', case: 'c', turn: 1 } }));
        await sales(request());
        assert.deepEqual(requests.map((r) => r.host), ['api.anthropic.com', 'api.meta.ai']);
        assert.equal(requests[0]!.apiKeyHeader, ANTHROPIC_KEY);
        assert.equal(requests[0]!.authorization, null);
        assert.equal(requests[1]!.authorization, `Bearer ${META_KEY}`);
        for (const r of requests) {
            assert.equal(r.rawBody!.includes(META_KEY) || r.rawBody!.includes(ANTHROPIC_KEY), false);
        }
        assert.equal(requests[0]!.rawBody!.includes(META_KEY), false);
        assert.equal(ledger.judgeUsd() > 0, true);
    });
});

describe('the ledger', () => {
    const call = (over: Record<string, unknown> = {}) => ({ role: 'reply', provider: 'meta', model: 'm', usd: 0.01, priced: true, tokensIn: 10, tokensOut: 5, cacheRead: 2, ms: 100, ok: true, ...over });

    it('adds up a case\'s own calls, perception and reply, and never the judge\'s', () => {
        const ledger = new Ledger();
        ledger.current = 'a';
        ledger.add(call({ role: 'perception', usd: 0.004 }));
        ledger.add(call({ role: 'reply', usd: 0.006 }));
        ledger.add(call({ role: 'judge', usd: 0.5 }));
        ledger.current = 'b';
        ledger.add(call({ usd: 0.1 }));
        ledger.current = null;
        assert.deepEqual(ledger.totalsFor('a'), { usd: 0.01, tokensIn: 24, tokensOut: 10, calls: 2 });
        assert.deepEqual(ledger.totalsFor('a', ['perception']), { usd: 0.004, tokensIn: 12, tokensOut: 5, calls: 1 });
        assert.equal(ledger.judgeUsd(), 0.5);
        assert.equal(ledger.usdOf('perception'), 0.004);
        assert.equal(ledger.totalsFor('nobody').calls, 0);
    });

    it('counts the calls charged at the table\'s ceiling', () => {
        const ledger = new Ledger();
        ledger.add(call({ priced: false }));
        ledger.add(call());
        assert.equal(ledger.unpriced(), 1);
    });
});

describe('makeAiCaller: what perceive() calls instead of the providers layer', () => {
    let previous: ReturnType<typeof setAiCaller>;
    beforeEach(() => { previous = setAiCaller(async () => { throw new Error('not set'); }); });
    afterEach(() => { setAiCaller(previous); });

    const args = (over: Partial<AiGenerateArgs> = {}): AiGenerateArgs => ({
        purpose: 'perception_dm', creatorId: 'benchmark-creator', system: '', user: [{ role: 'user', text: 'what is this' }], schema: SCHEMA, maxTokens: 3000, timeoutMs: 25_000, effort: 'low', ...over,
    });

    it('answers perception_dm on Meta at the purpose\'s effort, and says what it cost, with no row written anywhere', async () => {
        const { fetch, requests } = scriptedFetch(() => chatAnswer({ ok: true }, { prompt: 900, completion: 600 }));
        const ledger = new Ledger();
        const out = await makeAiCaller('muse-spark-1.3', { apiKey: META_KEY, ledger, fetchImpl: fetch })(args());
        assert.equal(requests[0]!.host, 'api.meta.ai');
        assert.equal(requests[0]!.body.reasoning_effort, 'low');
        assert.equal(out.provider, 'meta');
        assert.equal(out.model, 'muse-spark-1.3');
        assert.equal(out.route, 'saved');
        assert.equal(out.costSource, 'table');
        assert.equal(out.priced, true);
        assert.equal(out.usd, Math.round(((900 * 1.25 + 600 * 4.25) / 1e6) * 1e9) / 1e9);
        assert.equal(ledger.calls[0]!.role, 'perception');
    });

    it('routes the purposes only Meta answers (recall, the reel index) and the sales turn\'s own dm, and the purpose\'s role names them in the ledger', async () => {
        const { fetch } = scriptedFetch(() => chatAnswer({ ok: true }));
        const ledger = new Ledger();
        const caller = makeAiCaller('muse-spark-1.3', { apiKey: META_KEY, ledger, fetchImpl: fetch });
        for (const purpose of ['perception_dm', 'recall', 'reel_index', 'dm'] as const) await caller(args({ purpose }));
        assert.deepEqual(ledger.calls.map((c) => c.role), ['perception', 'recall', 'analysis', 'reply']);
    });

    it('refuses any other purpose before a request exists: nothing unexpected is ever sent anywhere', async () => {
        const { fetch, requests } = scriptedFetch(() => chatAnswer({ ok: true }));
        const caller = makeAiCaller('muse-spark-1.3', { apiKey: META_KEY, ledger: new Ledger(), fetchImpl: fetch });
        for (const purpose of ['dm_whatsapp', 'ads_draft', 'tenant_studio', 'onboarding_draft'] as const) {
            await assert.rejects(caller(args({ purpose })), (err: unknown) => err instanceof AiError && err.kind === 'no_provider', purpose);
        }
        assert.equal(requests.length, 0);
    });

    it('is what perceive() reads Muse through: the pinned prompt and the picture go out as a data URL, and what comes back is the description', async () => {
        const answer = { readable: true, seen: 'A price list.', transcript: '', about_owner: 'unclear', confidence: 0.9, mention_summary: '' };
        const { fetch, requests } = scriptedFetch(() => chatAnswer(answer, { prompt: 800, completion: 500 }));
        const ledger = new Ledger();
        setAiCaller(makeAiCaller('muse-spark-1.3', { apiKey: META_KEY, ledger, fetchImpl: fetch }));
        const bytes = Buffer.from('not really a picture');
        const out = await perceive({ creatorId: 'benchmark-creator', kind: 'image', typed: false, coverOnly: false, caption: null, handle: 'someone.else', language: 'Arabic', media: { kind: 'image', mime: 'image/png', base64: bytes.toString('base64') }, deadlineAt: Date.now() + 60_000 });
        assert.equal(out.perception.status, 'ok');
        assert.equal(out.perception.seen, 'A price list.');
        assert.ok(out.perception.usd > 0);
        const r = requests[0]!;
        assert.equal(hasMedia(r), true);
        const parts = messagesOf(r).find((m) => m.role === 'user').content;
        assert.match(parts[0].text, /^The customer shared the attached photo in an Instagram DM and wrote nothing with it\./);
        assert.equal(parts[1].image_url.url, `data:image/png;base64,${bytes.toString('base64')}`);
    });
});

describe('what is printed', () => {
    it('redactKeys takes a key out and changes nothing else: a table keeps its lines', () => {
        const table = `arm  cases\nmeta  15\n${META_KEY}`;
        assert.equal(redactKeys(table, META_KEY), 'arm  cases\nmeta  15\n[key]');
        assert.equal(redactKeys('x', null, undefined, 'short'), 'x');
        assert.equal(redactKeys('has short in it', 'short'), 'has short in it', 'a key under eight characters is not replaced: it would shred ordinary words');
    });

    it('scrubKey also makes a short reason of it: one line, with the key and anything key-shaped gone', () => {
        const out = scrubKey(`failed with ${META_KEY}\nand a second line ${'x'.repeat(300)}`, META_KEY);
        assert.equal(out.includes(META_KEY), false);
        assert.equal(out.includes('\n'), false);
        assert.ok(out.length <= 240);
    });

    it('billingOf prices the entries a response lists, each at its own model\'s price', () => {
        const b = billingOf({ billed: [], usage: { in: 1_000_000, out: 0 }, model: 'muse-spark-1.3' }, DEFAULT_PRICES);
        assert.equal(b.usd, 1.25);
        assert.equal(b.priced, true);
        const unknown = billingOf({ billed: [], usage: { in: 1000, out: 1000 }, model: 'a-model-with-no-price' }, DEFAULT_PRICES);
        assert.equal(unknown.priced, false);
        assert.ok(unknown.usd > 0, 'an unpriced model is charged at the ceiling, never nothing');
    });
});
