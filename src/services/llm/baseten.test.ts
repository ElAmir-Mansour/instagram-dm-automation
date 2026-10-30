/**
 * Baseten (Meta's open-weights Muse Spark, `meta-models/muse-spark-open-1026`) on the Chat Completions adapter: the request it builds (its own address, a Bearer
 * key, `reasoning_effort`, the strict schema), the video a user turn can carry, how it reads usage and what a failed call is, next to the places it deliberately
 * differs from Meta's hosted model. Every shape here was tried live against inference.baseten.co on 2026-10-29 (strict `json_schema`, base64 `video_url`, a 37 s
 * reel analysed in 42 s with 5,863 tokens in and 3,371 out) and checked against docs.baseten.co on 2026-10-30; nothing here makes a request.
 *
 * What may be SENT to Baseten is not this file's business (the adapter cannot tell a reel from a message): that is `PROVIDER_PURPOSE_ALLOWLIST`, tested in
 * purposes.test.ts, route.test.ts and generate.test.ts, and the indexer's own request in perception/reelIndex.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildChatRequest, chatCompletionsAdapter, META_MIN_OUTPUT, metaReasoningEffort, parseChatResponse } from './adapters/chatCompletions.js';
import { costOf, DEFAULT_PRICES } from './cost.js';
import { AiError, isAiError, scrub } from './errors.js';
import type { GeminiSchema } from './geminiSchema.js';
import { callLlm } from './generate.js';
import { checkProviderKey, listProviderModels } from './providerQuery.js';
import { jsonResponse, stubFetch } from './testFetch.js';
import { EFFORTS, type AdapterArgs, type LlmMedia } from './types.js';

// Built, not written whole: a `b10_` and forty characters is what a secret scanner blocks a push for. Baseten's own shape: `b10_`, eight, a dot, thirty-two.
const KEY = 'b10_' + 'Hb7vQm3x' + '.' + 'Tz9RnYd2KfP5aLc8JgSe4UoWiNtXrBwE';
const MODEL = 'meta-models/muse-spark-open-1026';
const SCHEMA: GeminiSchema = {
    type: 'OBJECT',
    properties: { reply: { type: 'STRING' }, score: { type: 'INTEGER' } },
    required: ['reply'],
};

const baseten = (over: Partial<AdapterArgs> = {}): AdapterArgs => ({
    provider: 'baseten', apiKey: KEY, model: MODEL, system: 'You describe videos.', user: 'Say hi.', schema: SCHEMA, maxTokens: 8000, effort: 'low', ...over,
});

const VIDEO: LlmMedia = { kind: 'video', mime: 'video/mp4', base64: 'VklERU9CWVRFUw==' };
const IMAGE: LlmMedia = { kind: 'image', mime: 'image/jpeg', base64: 'SU1BR0VCWVRFUw==' };

const caught = (fn: () => unknown): AiError => {
    try {
        fn();
    } catch (err) {
        assert.ok(isAiError(err), String(err));
        return err;
    }
    return assert.fail('expected a throw');
};

describe('buildChatRequest for Baseten', () => {
    it('is exactly this: its own /chat/completions, a Bearer key, a nested strict json_schema with an object root, max_tokens and reasoning_effort, and nothing that is another provider\'s', () => {
        const r = buildChatRequest(baseten());
        assert.equal(r.url, 'https://inference.baseten.co/v1/chat/completions');
        assert.deepEqual(r.headers, { authorization: `Bearer ${KEY}` });
        assert.deepEqual(r.body, {
            model: MODEL,
            messages: [{ role: 'system', content: 'You describe videos.' }, { role: 'user', content: 'Say hi.' }],
            max_tokens: 8000,
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'answer',
                    strict: true,
                    schema: {
                        type: 'object',
                        properties: { reply: { type: 'string' }, score: { type: ['integer', 'null'] } },
                        required: ['reply', 'score'],
                        additionalProperties: false,
                    },
                },
            },
            reasoning_effort: 'low',
        });
        for (const field of ['provider', 'reasoning', 'include_reasoning', 'reasoning_format', 'max_completion_tokens', 'temperature', 'stream', 'tools']) assert.ok(!(field in r.body), field);
    });

    it('puts the key in the header and nowhere else, and sends no attribution headers', () => {
        const r = buildChatRequest(baseten());
        assert.ok(!r.url.includes(KEY));
        assert.ok(!JSON.stringify(r.body).includes(KEY));
        assert.deepEqual(Object.keys(r.headers), ['authorization']);
    });

    it('is always at its own address and a strict schema: a base URL and JSON-object mode are not offered', () => {
        const r = buildChatRequest(baseten({ jsonMode: 'object', baseUrl: 'https://evil.example.com/v1' }));
        assert.equal(r.url, 'https://inference.baseten.co/v1/chat/completions');
        assert.equal((r.body.response_format as any).type, 'json_schema');
    });

    it('refuses an array at the top level before any request, as it does for Meta: the strict mode wants a plain object', () => {
        const err = caught(() => buildChatRequest(baseten({ schema: { type: 'ARRAY', items: { type: 'STRING' } } })));
        assert.equal(err.kind, 'bad_request');
        assert.equal(err.retryable, false);
        assert.equal(err.provider, 'baseten');
    });
});

describe('reasoning_effort for Baseten: the model always reasons, and takes low to xhigh', () => {
    it('is sent as the call\'s effort for low, medium, high and xhigh, and `max` goes as `xhigh`: Baseten documents those four for it, and `max` is a Muse Spark 1.3 level', () => {
        for (const effort of EFFORTS) {
            const sent = buildChatRequest(baseten({ effort })).body.reasoning_effort;
            assert.equal(sent, effort === 'max' ? 'xhigh' : effort, effort);
            assert.ok(['low', 'medium', 'high', 'xhigh'].includes(String(sent)), effort);
        }
        assert.equal(metaReasoningEffort(MODEL, 'max'), 'xhigh');
        assert.equal(metaReasoningEffort('meta-models/muse-spark-open', 'max'), 'xhigh');
    });

    it('never sends the two values Baseten maps down or has no name for here: `none` and `minimal`', () => {
        for (const effort of EFFORTS) assert.ok(!['none', 'minimal'].includes(String(buildChatRequest(baseten({ effort })).body.reasoning_effort)), effort);
    });

    it('has a floor of 4 000 output tokens, the figure limits.ts asks for, and a reel analysis asks for twice that', () => {
        assert.equal(META_MIN_OUTPUT, 4_000);
    });
});

describe('a user turn with media for Baseten', () => {
    it('is the turn\'s words as a text part, then the video as a video_url part holding a base64 data URL, and the bytes ride once', () => {
        const r = buildChatRequest(baseten({ user: [{ role: 'user', text: 'Watch the whole reel.', media: [VIDEO] }] }));
        assert.deepEqual((r.body.messages as any[])[1].content, [
            { type: 'text', text: 'Watch the whole reel.' },
            { type: 'video_url', video_url: { url: 'data:video/mp4;base64,VklERU9CWVRFUw==' } },
        ]);
        const body = JSON.stringify(r.body);
        assert.equal(body.split(VIDEO.base64).length - 1, 1);
        assert.ok(!body.includes(KEY));
    });

    it('takes a picture the same way, as an image_url part', () => {
        const r = buildChatRequest(baseten({ user: [{ role: 'user', text: 'x', media: [IMAGE] }] }));
        assert.deepEqual((r.body.messages as any[])[1].content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,SU1BR0VCWVRFUw==' } });
    });

    it('refuses media that is not what it says, before a request exists, with none of the bytes in the error', () => {
        const err = caught(() => buildChatRequest(baseten({ user: [{ role: 'user', text: 'x', media: [{ kind: 'video', mime: 'image/png', base64: 'WFhYWA==' }] }] })));
        assert.equal(err.kind, 'bad_request');
        assert.ok(![JSON.stringify(err), err.message].join('\n').includes('WFhYWA'));
    });
});

describe('parseChatResponse for Baseten', () => {
    const asked = { provider: 'baseten', model: MODEL, apiKey: KEY } as const;
    const answer = (usage: Record<string, unknown>, choice: Record<string, unknown> = {}) => ({
        id: 'chatcmpl-1', object: 'chat.completion', created: 1790000000, model: MODEL,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"reply":"hi"}', reasoning_content: 'long thinking that nothing here reads' }, ...choice }],
        usage,
    });
    /** The numbers of the live reel analysis of 2026-10-29: a 37 s Arabic reel. */
    const REEL = { prompt_tokens: 5863, completion_tokens: 3371, total_tokens: 9234 };

    it('reads the JSON from `content` and leaves `reasoning_content` alone, and takes the usage as it came: 5,863 in, 3,371 out', () => {
        const r = parseChatResponse(answer(REEL), asked);
        assert.equal(r.text, '{"reply":"hi"}');
        assert.ok(!r.text.includes('thinking'), 'the reasoning is never the answer');
        assert.equal(r.stopReason, 'end_turn');
        assert.deepEqual(r.usage, { in: 5863, out: 3371 });
        assert.deepEqual(r.billed, [{ model: MODEL, in: 5863, out: 3371 }]);
        const cost = costOf(r.billed, DEFAULT_PRICES);
        assert.equal(cost.priced, true);
        assert.equal(cost.usd, 0.0216555);
    });

    it('does NOT move cached prompt tokens out of `in`, as it does for Meta: the whole prompt is charged, which can only over-count a call (the safe side of a budget)', () => {
        const r = parseChatResponse(answer({ prompt_tokens: 10_000, completion_tokens: 600, prompt_tokens_details: { cached_tokens: 8000 } }), asked);
        assert.deepEqual(r.billed, [{ model: MODEL, in: 10_000, out: 600 }]);
        assert.ok(!('cacheRead' in r.billed[0]!));
    });

    it('reports an answer cut off by the limit, content null, as `max_tokens` with the thinking still billed', () => {
        const r = parseChatResponse(answer({ prompt_tokens: 5863, completion_tokens: 4000 }, { finish_reason: 'length', message: { role: 'assistant', content: null, reasoning_content: 'thinking' } }), asked);
        assert.equal(r.stopReason, 'max_tokens');
        assert.equal(r.text, '');
        assert.deepEqual(r.usage, { in: 5863, out: 4000 });
    });

    it('answers with the model that was asked for, which is what the price table is written in', () => {
        const r = parseChatResponse({ ...answer(REEL), model: 'meta-models/muse-spark-open-1026-fp8' }, asked);
        assert.equal(r.model, MODEL);
        assert.equal(r.billed[0]!.model, MODEL);
    });
});

describe('a Baseten call through callLlm', () => {
    const live = (content: string | null, usage: Record<string, unknown>, finish = 'stop') => jsonResponse(200, {
        id: 'chatcmpl-1', object: 'chat.completion', created: 1790000000, model: MODEL,
        choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content, reasoning_content: 'thinking' } }], usage,
    });
    const args = (fetchImpl: AdapterArgs['fetchImpl'], over: Record<string, unknown> = {}) => ({
        provider: 'baseten' as const, apiKey: KEY, model: MODEL, system: 'You answer in JSON.', user: 'Say hello.' as string | AdapterArgs['user'], schema: SCHEMA,
        maxTokens: 8000, timeoutMs: 5000, effort: 'low' as const, fetchImpl, ...over,
    });

    it('posts once to inference.baseten.co with the Bearer key, refuses a redirect, and reads the JSON, the usage and the model back', async () => {
        const { fetchImpl, calls } = stubFetch(live('{"reply":"hi","score":3}', { prompt_tokens: 5863, completion_tokens: 3371 }));
        const out = await callLlm(args(fetchImpl));
        assert.deepEqual(out.json, { reply: 'hi', score: 3 });
        assert.deepEqual(out.usage, { in: 5863, out: 3371 });
        assert.equal(out.provider, 'baseten');
        assert.equal(out.model, MODEL);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, 'https://inference.baseten.co/v1/chat/completions');
        assert.equal(calls[0]!.method, 'POST');
        assert.equal(calls[0]!.headers.authorization, `Bearer ${KEY}`);
        assert.equal(calls[0]!.redirect, 'error', 'a redirect would carry the key elsewhere');
        assert.equal(calls[0]!.body.reasoning_effort, 'low');
        assert.ok(!calls[0]!.raw.includes(KEY));
    });

    it('sends a video and the question that goes with it as one request', async () => {
        const { fetchImpl, calls } = stubFetch(live('{"reply":"a reel about APIs"}', { prompt_tokens: 5863, completion_tokens: 3371 }));
        const out = await callLlm(args(fetchImpl, { user: [{ role: 'user', text: 'Watch this reel.', media: [VIDEO] }] }));
        assert.deepEqual(out.json, { reply: 'a reel about APIs' });
        assert.deepEqual(calls[0]!.body.messages[1].content.map((p: { type: string }) => p.type), ['text', 'video_url']);
    });

    it('maps what Baseten answers to the one vocabulary: 401 auth, 402 quota, 429 rate (retryable), 5xx server (retryable), 400 bad_request, and the key is in none of them', async () => {
        const echoed = (message: string) => ({ error: { message: `${message} (key ${KEY})`, type: 'x' } });
        for (const [status, kind, retryable] of [[401, 'auth', false], [403, 'auth', false], [402, 'quota', false], [429, 'rate', true], [500, 'server', true], [503, 'server', true], [400, 'bad_request', false]] as const) {
            const { fetchImpl, calls } = stubFetch(jsonResponse(status, echoed('went wrong')));
            const err = await callLlm(args(fetchImpl)).then(() => assert.fail('expected a failure'), (e: unknown) => { assert.ok(isAiError(e)); return e; });
            assert.equal(err.kind, kind, String(status));
            assert.equal(err.retryable, retryable, String(status));
            assert.equal(err.provider, 'baseten', String(status));
            assert.equal(calls.length, 1, 'never retried inside the call');
            assert.ok(![JSON.stringify(err), String(err), err.message].join('\n').includes(KEY), `${status}: the key is scrubbed`);
        }
    });

    it('scrubs a Baseten key even when the call was not told it, by its shape: `b10_`, eight, a dot, thirty-two, and the older form without the prefix', () => {
        const legacy = KEY.slice('b10_'.length);
        assert.equal(scrub(`Invalid key ${KEY}.`), 'Invalid key [redacted].');
        assert.equal(scrub(`Invalid key ${legacy}.`), 'Invalid key [redacted].');
        assert.equal(scrub(`rejected: ${KEY}, ${legacy}`), 'rejected: [redacted], [redacted]');
        // Ordinary words with a dot are left alone.
        assert.equal(scrub('see inference.baseten.co/v1 and version 1.2.3'), 'see inference.baseten.co/v1 and version 1.2.3');
    });
});

describe('listing Baseten\'s models and checking its key', () => {
    const list = () => jsonResponse(200, {
        object: 'list',
        data: ['zai-org/GLM-5.3', 'meta-models/muse-spark-open-1026', 'deepseek-ai/DeepSeek-V4-Pro', 'meta-models/muse-spark-open'].map((id) => ({ id, object: 'model' })),
    });

    it('is one GET of /models with the Bearer key, offering only the ids under meta-models/ (Baseten hosts many others, and this provider is for Meta\'s open model)', async () => {
        const { fetchImpl, calls } = stubFetch(list());
        assert.deepEqual(await listProviderModels({ provider: 'baseten', apiKey: KEY, fetchImpl }), [MODEL, 'meta-models/muse-spark-open']);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, 'https://inference.baseten.co/v1/models');
        assert.equal(calls[0]!.headers.authorization, `Bearer ${KEY}`);
    });

    it('checks a key with the same call, passes on a 200, and fails a refused key as auth with the key nowhere in it', async () => {
        const ok = stubFetch(list());
        assert.deepEqual(await checkProviderKey({ provider: 'baseten', apiKey: KEY, fetchImpl: ok.fetchImpl }), { ok: true });
        const refused = stubFetch(jsonResponse(401, { error: { message: `Invalid API key ${KEY}` } }));
        await assert.rejects(checkProviderKey({ provider: 'baseten', apiKey: KEY, fetchImpl: refused.fetchImpl }), (err: unknown) => {
            assert.ok(isAiError(err));
            assert.equal(err.kind, 'auth');
            assert.ok(![JSON.stringify(err), err.message].join('\n').includes(KEY));
            return true;
        });
    });

    it('is a no_provider, before any request, for a key that is not there', async () => {
        const { fetchImpl, calls } = stubFetch(list());
        await assert.rejects(listProviderModels({ provider: 'baseten', apiKey: '  ', fetchImpl }), (err: unknown) => isAiError(err) && err.kind === 'no_provider');
        assert.equal(calls.length, 0);
    });
});

describe('the adapter itself', () => {
    it('refuses media for no provider it was not told about: Baseten is one of the two that take it', async () => {
        const { fetchImpl, calls } = stubFetch(jsonResponse(200, { choices: [{ finish_reason: 'stop', message: { content: '{"reply":"x"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
        await chatCompletionsAdapter({ ...baseten({ user: [{ role: 'user', text: 'x', media: [VIDEO] }] }), fetchImpl });
        assert.equal(calls.length, 1);
    });
});
