/**
 * Meta (Muse) on the Chat Completions adapter: the request it builds (its own address, `reasoning_effort`, the strict schema), the pictures and video
 * a user turn can carry (inline base64 `data:` URLs, and nobody else is sent them), how it reads usage (cached tokens are a subset of the prompt),
 * and, above all, that a request with no media is exactly what it was before this provider existed. Every shape here was tried live against
 * api.meta.ai on 2026-10-28 to 10-30; the model list and key check are in providerQuery.test.ts, the generic failures in generate.test.ts.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { buildAnthropicRequest } from './adapters/anthropic.js';
import {
    buildChatRequest, chatCompletionsAdapter, MEDIA_PROVIDERS, META_MIN_OUTPUT, metaReasoningEffort, parseChatResponse,
} from './adapters/chatCompletions.js';
import { buildGeminiRequest } from './adapters/gemini.js';
import { mediaOf } from './adapters/media.js';
import { buildOpenAiRequest } from './adapters/openai.js';
import { costOf, DEFAULT_PRICES, totalUsage } from './cost.js';
import { type AiError, isAiError } from './errors.js';
import type { GeminiSchema } from './geminiSchema.js';
import { callLlm } from './generate.js';
import { jsonResponse, stubFetch } from './testFetch.js';
import { EFFORTS, type AdapterArgs, type Effort, type LlmMedia, type LlmTurn } from './types.js';

const KEY = 'meta-key-Hb7vQm3xTz9RnYd2KfP5aLc8JgSe4UoWiNtXrBwEs6Vq';
const SCHEMA: GeminiSchema = {
    type: 'OBJECT',
    properties: { reply: { type: 'STRING' }, score: { type: 'INTEGER' } },
    required: ['reply'],
};

const meta = (over: Partial<AdapterArgs> = {}): AdapterArgs => ({
    provider: 'meta', apiKey: KEY, model: 'muse-spark-1.3', system: 'You write replies.', user: 'Say hi.', schema: SCHEMA, maxTokens: 4000, effort: 'low', ...over,
});

/** A few bytes that cannot be mistaken for anything else in a body: each test looks for exactly its own. */
const IMAGE: LlmMedia = { kind: 'image', mime: 'image/jpeg', base64: 'SU1BR0VCWVRFUw==' };
const VIDEO: LlmMedia = { kind: 'video', mime: 'video/mp4', base64: 'VklERU9CWVRFUw==' };

const caught = (fn: () => unknown): AiError => {
    try {
        fn();
    } catch (err) {
        assert.ok(isAiError(err), String(err));
        return err;
    }
    return assert.fail('expected a throw');
};

/** What a person's picture or video must never be in: an error, a log line, anything a screen or a log would show. */
const printed = (err: AiError): string => [JSON.stringify(err), String(err), err.message, err.stack ?? ''].join('\n');

describe('buildChatRequest for Meta', () => {
    it('is exactly this: its own /chat/completions, a nested strict json_schema, max_tokens and reasoning_effort, and nothing that is another provider\'s', () => {
        const r = buildChatRequest(meta());
        assert.equal(r.url, 'https://api.meta.ai/v1/chat/completions');
        assert.deepEqual(r.headers, { authorization: `Bearer ${KEY}` });
        assert.deepEqual(r.body, {
            model: 'muse-spark-1.3',
            messages: [{ role: 'system', content: 'You write replies.' }, { role: 'user', content: 'Say hi.' }],
            max_tokens: 4000,
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
        // OpenRouter's, Groq's and OpenAI's own fields are not sent to Meta, whatever the model is called.
        for (const field of ['provider', 'reasoning', 'include_reasoning', 'reasoning_format', 'max_completion_tokens', 'temperature', 'stream', 'tools']) assert.ok(!(field in r.body), field);
    });

    it('puts the key in the header and nowhere else, and sends no attribution headers', () => {
        const r = buildChatRequest(meta());
        assert.ok(!r.url.includes(KEY));
        assert.ok(!JSON.stringify(r.body).includes(KEY));
        assert.deepEqual(Object.keys(r.headers), ['authorization']);
    });

    it('is always a strict schema and always at its own address: JSON-object mode and a base URL are not offered', () => {
        const r = buildChatRequest(meta({ jsonMode: 'object', baseUrl: 'https://evil.example.com/v1' }));
        assert.equal((r.body.response_format as any).type, 'json_schema');
        assert.equal(r.url, 'https://api.meta.ai/v1/chat/completions');
    });

    it('refuses an array at the top level before any request, because Meta\'s strict mode wants a plain object there', () => {
        const err = caught(() => buildChatRequest(meta({ schema: { type: 'ARRAY', items: { type: 'STRING' } } })));
        assert.equal(err.kind, 'bad_request');
        assert.equal(err.retryable, false);
        assert.equal(err.provider, 'meta');
        assert.match(err.message, /^Meta's strict structured output needs the answer to be a JSON object at the top level/);
    });

    it('refuses a schema strict mode cannot express, before any request', () => {
        const err = caught(() => buildChatRequest(meta({ schema: { json: { type: 'object', properties: { m: { type: 'object', additionalProperties: { type: 'string' } } } } } })));
        assert.equal(err.kind, 'bad_request');
        assert.match(err.message, /free-form keys/);
    });

    it('maps a conversation, leaving out an empty system prompt', () => {
        const r = buildChatRequest(meta({ system: '', user: [{ role: 'user', text: 'one' }, { role: 'model', text: 'two' }, { role: 'user', text: 'three' }] }));
        assert.deepEqual(r.body.messages, [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }, { role: 'user', content: 'three' }]);
    });
});

describe('reasoning_effort: Muse Spark always reasons, so it is always told how hard', () => {
    it('is sent as the call\'s effort, for each of the five, on Muse Spark 1.3 and Muse Wonder', () => {
        for (const model of ['muse-spark-1.3', 'muse-wonder-1.0']) {
            for (const effort of EFFORTS) assert.equal(buildChatRequest(meta({ model, effort })).body.reasoning_effort, effort, `${model} ${effort}`);
        }
    });

    it('sends `max` as `xhigh` for every other model, because Meta documents `max` for Muse Spark 1.3 and Muse Wonder alone', () => {
        for (const model of ['muse-spark-1.2', 'muse-spark-1.1', 'muse-spark-1.30', 'muse-spark-open-1026', 'some-new-muse', '']) {
            assert.equal(buildChatRequest(meta({ model, effort: 'max' })).body.reasoning_effort, 'xhigh', model);
            // Nothing else is touched: the levels Meta takes everywhere go as they are.
            for (const effort of ['low', 'medium', 'high', 'xhigh'] as const) assert.equal(buildChatRequest(meta({ model, effort })).body.reasoning_effort, effort, `${model} ${effort}`);
        }
    });

    it('reads the model id without regard to case or space, and says what it sends', () => {
        assert.equal(metaReasoningEffort('  MUSE-SPARK-1.3 ', 'max'), 'max');
        assert.equal(metaReasoningEffort('Muse-Wonder-1.0', 'max'), 'max');
        assert.equal(metaReasoningEffort('muse-spark-1.2', 'max'), 'xhigh');
        assert.equal(metaReasoningEffort('muse-spark-1.2', 'low'), 'low');
    });

    it('never sends the two values Meta refuses or has no name for here: `none` (a 400) and `minimal`', () => {
        for (const model of ['muse-spark-1.3', 'muse-spark-1.2', 'muse-wonder-1.0']) {
            for (const effort of EFFORTS) assert.ok(!['none', 'minimal'].includes(String(buildChatRequest(meta({ model, effort })).body.reasoning_effort)), `${model} ${effort}`);
        }
    });

    it('is sent for Meta alone: no other provider on this format is told reasoning_effort for a model with a Muse name', () => {
        const other = (provider: 'openrouter' | 'custom') => ({ provider, model: 'muse-spark-1.3', effort: 'high' as Effort, ...(provider === 'custom' ? { baseUrl: 'https://llm.example.com/v1' } : {}) });
        for (const provider of ['openrouter', 'custom'] as const) assert.ok(!('reasoning_effort' in buildChatRequest(meta(other(provider))).body), provider);
    });

    it('has a floor of 4 000 output tokens, the figure limits.ts asks for', () => {
        assert.equal(META_MIN_OUTPUT, 4_000);
    });
});

describe('a user turn with media', () => {
    it('is the turn\'s words as a text part, then its picture as an image_url part holding a base64 data URL', () => {
        const r = buildChatRequest(meta({ user: [{ role: 'user', text: 'The customer shared the attached image.', media: [IMAGE] }] }));
        assert.deepEqual(r.body.messages, [
            { role: 'system', content: 'You write replies.' },
            { role: 'user', content: [
                { type: 'text', text: 'The customer shared the attached image.' },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,SU1BR0VCWVRFUw==' } },
            ] },
        ]);
    });

    it('is a video_url part for a video, with the same kind of URL', () => {
        const r = buildChatRequest(meta({ user: [{ role: 'user', text: 'Watch this.', media: [VIDEO] }] }));
        assert.deepEqual((r.body.messages as any[])[1].content, [
            { type: 'text', text: 'Watch this.' },
            { type: 'video_url', video_url: { url: 'data:video/mp4;base64,VklERU9CWVRFUw==' } },
        ]);
    });

    it('keeps several in the order given, after the words, whichever kinds they are', () => {
        const second: LlmMedia = { kind: 'image', mime: 'image/png', base64: 'U0VDT05E' };
        const r = buildChatRequest(meta({ user: [{ role: 'user', text: 'Look.', media: [IMAGE, VIDEO, second] }] }));
        const parts = (r.body.messages as any[])[1].content as Array<{ type: string }>;
        assert.deepEqual(parts.map((p) => p.type), ['text', 'image_url', 'video_url', 'image_url']);
        assert.equal((parts[3] as any).image_url.url, 'data:image/png;base64,U0VDT05E');
    });

    it('leaves the text part out when there are no words: an empty text part is not something to send', () => {
        const r = buildChatRequest(meta({ user: [{ role: 'user', text: '', media: [VIDEO] }] }));
        assert.deepEqual((r.body.messages as any[])[1].content, [{ type: 'video_url', video_url: { url: 'data:video/mp4;base64,VklERU9CWVRFUw==' } }]);
    });

    it('trims the type, so a padded one cannot break the URL', () => {
        const r = buildChatRequest(meta({ user: [{ role: 'user', text: 'x', media: [{ ...IMAGE, mime: '  image/webp \n' }] }] }));
        assert.equal((r.body.messages as any[])[1].content[1].image_url.url, 'data:image/webp;base64,SU1BR0VCWVRFUw==');
    });

    it('rides with one turn of a conversation and leaves the others as the plain strings they were', () => {
        const user: LlmTurn[] = [
            { role: 'user', text: 'earlier' },
            { role: 'model', text: 'reply' },
            { role: 'user', text: 'now this', media: [IMAGE] },
        ];
        const messages = buildChatRequest(meta({ system: '', user })).body.messages as any[];
        assert.deepEqual(messages.slice(0, 2), [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }]);
        assert.equal(Array.isArray(messages[2].content), true);
        assert.equal(messages.length, 3);
    });

    it('carries the bytes exactly as given, once, and never the key', () => {
        const r = buildChatRequest(meta({ user: [{ role: 'user', text: 'x', media: [IMAGE, VIDEO] }] }));
        const body = JSON.stringify(r.body);
        assert.equal(body.split(IMAGE.base64).length - 1, 1);
        assert.equal(body.split(VIDEO.base64).length - 1, 1);
        assert.ok(!body.includes(KEY));
        assert.ok(!r.url.includes(IMAGE.base64));
    });

    it('is still refused for a model\'s own turn: only a user turn can carry a picture, and nothing is quoted of the bytes', () => {
        const err = caught(() => buildChatRequest(meta({ user: [{ role: 'user', text: 'a' }, { role: 'model', text: 'b', media: [IMAGE] }] })));
        assert.equal(err.kind, 'bad_request');
        assert.equal(err.retryable, false);
        assert.match(err.message, /Turn 2 is the model's own and carries media: only a user turn can\./);
        assert.ok(!printed(err).includes(IMAGE.base64));
    });

    it('refuses media that is not what it says, naming the turn and the piece and quoting none of the bytes', () => {
        const bad: Array<[string, LlmMedia, RegExp]> = [
            ['an unknown kind', { kind: 'audio', mime: 'audio/wav', base64: 'QVVESU8=' } as unknown as LlmMedia, /Media 1 of turn 1 is neither an image nor a video\./],
            ['a type of the other kind', { kind: 'image', mime: 'video/mp4', base64: 'WFhYWA==' }, /Media 1 of turn 1 says it is an image but its type is not image\/…\./],
            ['a type that would end the URL early', { kind: 'image', mime: 'image/jpeg;base64,AAAA', base64: 'WFhYWA==' }, /its type is not image\//],
            ['no type at all', { kind: 'video', mime: '', base64: 'WFhYWA==' }, /its type is not video\//],
            ['no bytes', { kind: 'image', mime: 'image/png', base64: '' }, /Media 1 of turn 1 has no bytes\./],
            ['bytes already in a data URL', { kind: 'image', mime: 'image/png', base64: 'data:image/png;base64,WFhYWA==' }, /must be the bare base64 bytes, without a data: prefix\./],
            ['bytes that are not a string', { kind: 'image', mime: 'image/png', base64: 42 } as unknown as LlmMedia, /has no bytes\./],
        ];
        for (const [what, media, message] of bad) {
            const err = caught(() => buildChatRequest(meta({ user: [{ role: 'user', text: 'x', media: [media] }] })));
            assert.equal(err.kind, 'bad_request', what);
            assert.equal(err.retryable, false, what);
            assert.match(err.message, message, what);
            assert.ok(!printed(err).includes('WFhYWA'), `${what}: no bytes in the error`);
        }
        // The second piece of the second turn is named as such.
        const err = caught(() => buildChatRequest(meta({ user: [{ role: 'user', text: 'a' }, { role: 'user', text: 'b', media: [IMAGE, { kind: 'image', mime: 'image/png', base64: '' }] }] })));
        assert.match(err.message, /Media 2 of turn 2 has no bytes\./);
    });
});

describe('a request with no media is what it was before this provider existed', () => {
    it('treats a turn with `media: []` or `media: undefined` as a plain turn: the same body, byte for byte, for Meta and every other provider on this format', () => {
        const plain: LlmTurn[] = [{ role: 'user', text: 'one' }, { role: 'model', text: 'two' }, { role: 'user', text: 'three' }];
        const withEmpty: LlmTurn[] = plain.map((t, i) => ({ ...t, ...(i % 2 === 0 ? { media: [] } : { media: undefined }) }));
        for (const args of [
            meta(),
            { provider: 'openrouter', apiKey: KEY, model: 'openrouter/auto' },
            { provider: 'groq', apiKey: KEY, model: 'openai/gpt-oss-120b' },
            { provider: 'custom', apiKey: KEY, model: 'llama-4-maverick', baseUrl: 'https://llm.example.com/v1' },
        ] as Array<Partial<AdapterArgs>>) {
            const make = (user: LlmTurn[]) => JSON.stringify(buildChatRequest({ ...meta(), ...args, user }));
            assert.equal(make(withEmpty), make(plain), String(args.provider));
            assert.ok(!make(plain).includes('image_url') && !make(plain).includes('video_url'), String(args.provider));
        }
    });

    it('gives Meta the plain string content a text-only turn always had: never a one-element parts array', () => {
        const messages = buildChatRequest(meta({ user: [{ role: 'user', text: 'just words' }] })).body.messages as any[];
        assert.equal(typeof messages[1].content, 'string');
    });

    // The exact bytes the BASE commit (dbc8319) built for these inputs, taken from its own adapters before this change. A provider that was here before is
    // asked for what it always was asked for: if one of these moves, so did a request that is in production.
    const KEY0 = 'k-0000000000000000';
    const SCHEMA0: GeminiSchema = { type: 'OBJECT', properties: { reply: { type: 'STRING' }, score: { type: 'INTEGER' } }, required: ['reply'] };
    const THREE: LlmTurn[] = [{ role: 'user', text: 'one' }, { role: 'model', text: 'two' }, { role: 'user', text: 'three' }];
    const base = { apiKey: KEY0, schema: SCHEMA0, maxTokens: 4000, effort: 'medium' } as const;

    it('is unchanged for OpenRouter, Groq and Custom: a text request is the base commit\'s, byte for byte', () => {
        assert.equal(
            JSON.stringify(buildChatRequest({ provider: 'openrouter', model: 'openrouter/auto', system: 'You write replies.', user: 'Say hi.', ...base })),
            '{"url":"https://openrouter.ai/api/v1/chat/completions","headers":{"authorization":"Bearer k-0000000000000000"},"body":{"model":"openrouter/auto","messages":[{"role":"system","content":"You write replies."},{"role":"user","content":"Say hi."}],"max_tokens":4000,"response_format":{"type":"json_schema","json_schema":{"name":"answer","strict":true,"schema":{"type":"object","properties":{"reply":{"type":"string"},"score":{"type":["integer","null"]}},"required":["reply","score"],"additionalProperties":false}}},"provider":{"require_parameters":true}}}',
        );
        assert.equal(
            JSON.stringify(buildChatRequest({ provider: 'groq', model: 'openai/gpt-oss-120b', system: '', user: THREE, ...base })),
            '{"url":"https://api.groq.com/openai/v1/chat/completions","headers":{"authorization":"Bearer k-0000000000000000"},"body":{"model":"openai/gpt-oss-120b","messages":[{"role":"user","content":"one"},{"role":"assistant","content":"two"},{"role":"user","content":"three"}],"max_tokens":4000,"response_format":{"type":"json_schema","json_schema":{"name":"answer","strict":true,"schema":{"type":"object","properties":{"reply":{"type":"string"},"score":{"type":["integer","null"]}},"required":["reply","score"],"additionalProperties":false}}},"reasoning_effort":"medium","include_reasoning":false}}',
        );
        assert.equal(
            JSON.stringify(buildChatRequest({ provider: 'custom', model: 'llama-4-maverick', baseUrl: 'https://llm.example.com/v1', system: 'You write replies.', user: 'Say hi.', ...base })),
            '{"url":"https://llm.example.com/v1/chat/completions","headers":{"authorization":"Bearer k-0000000000000000"},"body":{"model":"llama-4-maverick","messages":[{"role":"system","content":"You write replies."},{"role":"user","content":"Say hi."}],"max_tokens":4000,"response_format":{"type":"json_schema","json_schema":{"name":"answer","strict":true,"schema":{"type":"object","properties":{"reply":{"type":"string"},"score":{"type":["integer","null"]}},"required":["reply","score"],"additionalProperties":false}}}}}',
        );
    });

    it('is unchanged for Anthropic, OpenAI and Gemini: a conversation request is the base commit\'s, byte for byte', () => {
        assert.equal(
            JSON.stringify(buildAnthropicRequest({ provider: 'anthropic', model: 'claude-opus-5-5', system: 'You write replies.', user: THREE, ...base })),
            '{"url":"https://api.anthropic.com/v1/messages","headers":{"x-api-key":"k-0000000000000000","anthropic-version":"2023-06-01","anthropic-beta":"server-side-fallback-2026-07-01"},"body":{"model":"claude-opus-5-5","max_tokens":4000,"system":"You write replies.","messages":[{"role":"user","content":"one"},{"role":"assistant","content":"two"},{"role":"user","content":"three"}],"output_config":{"format":{"type":"json_schema","schema":{"type":"object","properties":{"reply":{"type":"string"},"score":{"type":"integer"}},"required":["reply"],"additionalProperties":false}},"effort":"medium"},"fallbacks":"default"}}',
        );
        assert.equal(
            JSON.stringify(buildOpenAiRequest({ provider: 'openai', model: 'gpt-6-astra', system: 'You write replies.', user: THREE, ...base })),
            '{"url":"https://api.openai.com/v1/responses","headers":{"authorization":"Bearer k-0000000000000000"},"body":{"model":"gpt-6-astra","instructions":"You write replies.","input":[{"role":"user","content":"one"},{"role":"assistant","content":"two"},{"role":"user","content":"three"}],"text":{"format":{"type":"json_schema","name":"answer","schema":{"type":"object","properties":{"reply":{"type":"string"},"score":{"type":["integer","null"]}},"required":["reply","score"],"additionalProperties":false},"strict":true}},"store":false,"max_output_tokens":4000,"reasoning":{"effort":"medium"}}}',
        );
        assert.equal(
            JSON.stringify(buildGeminiRequest({ provider: 'gemini', model: 'gemini-3.8-flash', system: 'You write replies.', user: THREE, ...base })),
            '{"url":"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent","headers":{"x-goog-api-key":"k-0000000000000000"},"body":{"systemInstruction":{"parts":[{"text":"You write replies."}]},"contents":[{"role":"user","parts":[{"text":"one"}]},{"role":"model","parts":[{"text":"two"}]},{"role":"user","parts":[{"text":"three"}]}],"generationConfig":{"responseMimeType":"application/json","responseSchema":{"type":"OBJECT","properties":{"reply":{"type":"STRING"},"score":{"type":"INTEGER"}},"required":["reply"]},"maxOutputTokens":4000,"thinkingConfig":{"thinkingLevel":"medium"}}}}',
        );
    });
});

describe('only Meta (Muse) is sent pictures and video: hosted by Meta, or by Baseten for the reel indexer', () => {
    const withMedia = (over: Partial<AdapterArgs>): AdapterArgs => ({ ...meta(), user: [{ role: 'user', text: 'see this', media: [IMAGE, VIDEO] }], ...over });

    it('lists Meta and Baseten (Meta\'s open model, the owner\'s reels alone: purposes.ts) on the Chat Completions format, and no one else', () => {
        assert.deepEqual([...MEDIA_PROVIDERS], ['meta', 'baseten']);
    });

    it('is refused by OpenRouter, Groq and Custom with a final bad_request before a request exists, naming the provider and none of the bytes', () => {
        for (const over of [
            { provider: 'openrouter', model: 'openrouter/auto' },
            { provider: 'groq', model: 'openai/gpt-oss-120b' },
            { provider: 'custom', model: 'llama-4-maverick', baseUrl: 'https://llm.example.com/v1' },
        ] as Array<Partial<AdapterArgs>>) {
            const err = caught(() => buildChatRequest(withMedia(over)));
            assert.equal(err.kind, 'bad_request', String(over.provider));
            assert.equal(err.retryable, false);
            assert.equal(err.provider, over.provider);
            assert.match(err.message, /is not sent pictures or video through this layer: only Meta \(Muse\) takes them\./);
            const text = printed(err);
            for (const secret of [IMAGE.base64, VIDEO.base64, KEY]) assert.ok(!text.includes(secret), `${over.provider}: ${secret.slice(0, 8)}`);
        }
    });

    it('is refused by Anthropic, OpenAI and Gemini the same way', () => {
        const args = (provider: AdapterArgs['provider'], model: string): AdapterArgs => withMedia({ provider, model });
        for (const [build, provider, model, name] of [
            [buildAnthropicRequest, 'anthropic', 'claude-opus-5-5', 'Anthropic'],
            [buildOpenAiRequest, 'openai', 'gpt-6-astra', 'OpenAI'],
            [buildGeminiRequest, 'gemini', 'gemini-3.8-flash', 'Google Gemini'],
        ] as const) {
            const err = caught(() => build(args(provider, model)));
            assert.equal(err.kind, 'bad_request', provider);
            assert.equal(err.retryable, false, provider);
            assert.equal(err.provider, provider);
            assert.ok(err.message.startsWith(`${name} is not sent pictures or video through this layer`), `${provider}: ${err.message}`);
            for (const secret of [IMAGE.base64, VIDEO.base64, KEY]) assert.ok(!printed(err).includes(secret), provider);
        }
    });

    it('makes no request at all when it refuses: the adapter fails before it can reach fetch', async () => {
        for (const over of [{ provider: 'openrouter', model: 'openrouter/auto' }, { provider: 'groq', model: 'openai/gpt-oss-120b' }] as Array<Partial<AdapterArgs>>) {
            const { fetchImpl, calls } = stubFetch(jsonResponse(200, {}));
            await assert.rejects(chatCompletionsAdapter({ ...withMedia(over), fetchImpl }), (err: unknown) => isAiError(err) && err.kind === 'bad_request');
            assert.equal(calls.length, 0, String(over.provider));
        }
    });

    it('lets `media: []` through on every provider: an empty list is no media', () => {
        const turns: LlmTurn[] = [{ role: 'user', text: 'words only', media: [] }];
        const base = meta({ user: turns });
        buildChatRequest(base);
        buildChatRequest({ ...base, provider: 'groq', model: 'openai/gpt-oss-120b' });
        buildAnthropicRequest({ ...base, provider: 'anthropic', model: 'claude-opus-5-5' });
        buildOpenAiRequest({ ...base, provider: 'openai', model: 'gpt-6-astra' });
        buildGeminiRequest({ ...base, provider: 'gemini', model: 'gemini-3.8-flash' });
    });

    it('counts media across every turn, and none in a plain string', () => {
        assert.deepEqual(mediaOf('words'), []);
        assert.deepEqual(mediaOf([{ role: 'user', text: 'a' }, { role: 'user', text: 'b', media: [] }]), []);
        assert.deepEqual(mediaOf([{ role: 'user', text: 'a', media: [IMAGE] }, { role: 'model', text: 'b' }, { role: 'user', text: 'c', media: [VIDEO, IMAGE] }]), [IMAGE, VIDEO, IMAGE]);
    });
});

describe('parseChatResponse for Meta', () => {
    const asked = { provider: 'meta', model: 'muse-spark-1.3', apiKey: KEY } as const;
    const answer = (usage: Record<string, unknown>, choice: Record<string, unknown> = {}) => ({
        id: 'chatcmpl-1', object: 'chat.completion', created: 1790000000, model: 'muse-spark-1.3',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"reply":"hi"}' }, ...choice }],
        usage,
    });
    /** Exactly what api.meta.ai returned on 2026-10-28 for a one-word answer. */
    const LIVE = { completion_tokens: 190, prompt_tokens: 15, total_tokens: 205, completion_tokens_details: { reasoning_tokens: 180 }, prompt_tokens_details: { cached_tokens: 0 } };

    it('reads the usage Meta returned live: 15 tokens in, 190 out, the 180 of thinking inside them, and nothing cached', () => {
        const r = parseChatResponse(answer(LIVE), asked);
        assert.equal(r.text, '{"reply":"hi"}');
        assert.equal(r.stopReason, 'end_turn');
        assert.deepEqual(r.usage, { in: 15, out: 190 });
        assert.deepEqual(r.billed, [{ model: 'muse-spark-1.3', in: 15, out: 190 }]);
        assert.ok(!('cacheRead' in r.billed[0]!), 'absent, not zero, when nothing was cached');
        // All 190 are output tokens: the thinking is billed at the output rate and is already counted, so it is not added again.
        assert.equal(costOf(r.billed, DEFAULT_PRICES).usd, 0.00082625);
        assert.equal(costOf(r.billed, DEFAULT_PRICES).priced, true);
    });

    it('moves cached prompt tokens out of `in` and into `cacheRead`: they are a subset of prompt_tokens, priced at $0.15 a million, not charged twice', () => {
        const usage = { prompt_tokens: 10_000, completion_tokens: 600, total_tokens: 10_600, prompt_tokens_details: { cached_tokens: 8000 } };
        const r = parseChatResponse(answer(usage), asked);
        assert.deepEqual(r.billed, [{ model: 'muse-spark-1.3', in: 2000, out: 600, cacheRead: 8000 }]);
        assert.deepEqual(r.usage, { in: 2000, out: 600, cacheRead: 8000 });
        // 2,000 * 1.25 + 8,000 * 0.15 + 600 * 4.25, per million.
        assert.equal(costOf(r.billed, DEFAULT_PRICES).usd, 0.00625);
        assert.deepEqual(totalUsage(r.billed), { in: 2000, out: 600, cacheRead: 8000 });
    });

    it('never lets more be cached than was sent, nor a count that is not a number', () => {
        assert.deepEqual(parseChatResponse(answer({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 150 } }), asked).billed, [{ model: 'muse-spark-1.3', in: 0, out: 5, cacheRead: 100 }]);
        for (const cached of ['8000', null, -5, Number.NaN, {}]) {
            const r = parseChatResponse(answer({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: cached } }), asked);
            assert.deepEqual(r.billed, [{ model: 'muse-spark-1.3', in: 100, out: 5 }], String(cached));
        }
        assert.deepEqual(parseChatResponse(answer({ prompt_tokens: 100, completion_tokens: 5 }), asked).billed, [{ model: 'muse-spark-1.3', in: 100, out: 5 }]);
        assert.deepEqual(parseChatResponse(answer({}), asked).billed, [{ model: 'muse-spark-1.3', in: 0, out: 0 }]);
    });

    it('does the same for no other provider: the cached count of Groq, OpenRouter and Custom is ignored, as it always was', () => {
        const usage = { prompt_tokens: 10_000, completion_tokens: 600, prompt_tokens_details: { cached_tokens: 8000 } };
        for (const provider of ['groq', 'openrouter', 'custom'] as const) {
            const r = parseChatResponse(answer(usage), { provider, model: 'some-model', apiKey: KEY });
            assert.deepEqual(r.billed.map(({ model, in: i, out }) => ({ model, in: i, out })), [{ model: 'some-model', in: 10_000, out: 600 }], provider);
            assert.ok(!('cacheRead' in r.billed[0]!), provider);
        }
    });

    it('reports a Meta answer cut off by the limit, content null, as `max_tokens` with the thinking still billed', () => {
        // The shape the live tests got below about 1,000 to 2,000 tokens: no text, and every token spent on reasoning.
        const r = parseChatResponse(answer(
            { prompt_tokens: 15, completion_tokens: 200, total_tokens: 215, completion_tokens_details: { reasoning_tokens: 200 } },
            { finish_reason: 'length', message: { role: 'assistant', content: null } },
        ), asked);
        assert.equal(r.stopReason, 'max_tokens');
        assert.equal(r.text, '');
        assert.deepEqual(r.usage, { in: 15, out: 200 });
    });

    it('answers with the model that was asked for, which is what the price table is written in', () => {
        const r = parseChatResponse({ ...answer(LIVE), model: 'muse-spark-1.3-20261101' }, asked);
        assert.equal(r.model, 'muse-spark-1.3');
        assert.equal(r.billed[0]!.model, 'muse-spark-1.3');
    });

    it('does not take Meta\'s answer for a priced one: the response carries no cost, so the table prices it', () => {
        const r = parseChatResponse(answer({ ...LIVE, cost: 123 }), asked);
        assert.ok(!('usd' in r.billed[0]!) && !('source' in r.billed[0]!));
    });
});

describe('a Meta call through callLlm', () => {
    const lines: Array<Record<string, any>> = [];
    let restore: (() => void) | undefined;
    afterEach(() => restore?.());
    const capture = () => {
        lines.length = 0;
        const previous = setLogSink((_level, line) => void lines.push(JSON.parse(line)));
        restore = () => void setLogSink(previous);
    };
    const live = (content: string | null, usage: Record<string, unknown>, finish = 'stop') => jsonResponse(200, {
        id: 'chatcmpl-1', object: 'chat.completion', created: 1790000000, model: 'muse-spark-1.3',
        choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }], usage,
    });
    const args = (fetchImpl: AdapterArgs['fetchImpl'], over: Record<string, unknown> = {}) => ({
        provider: 'meta' as const, apiKey: KEY, model: 'muse-spark-1.3', system: 'You answer in JSON.', user: 'Say hello.' as string | LlmTurn[], schema: SCHEMA,
        maxTokens: 4000, timeoutMs: 5000, effort: 'low' as const, fetchImpl, ...over,
    });

    it('posts once to api.meta.ai with the bearer key, and reads the JSON, the usage and the model back', async () => {
        capture();
        const { fetchImpl, calls } = stubFetch(live('{"reply":"hi","score":3}', { prompt_tokens: 15, completion_tokens: 190, total_tokens: 205, completion_tokens_details: { reasoning_tokens: 180 } }));
        const out = await callLlm(args(fetchImpl));
        assert.deepEqual(out.json, { reply: 'hi', score: 3 });
        assert.deepEqual(out.usage, { in: 15, out: 190 });
        assert.equal(out.provider, 'meta');
        assert.equal(out.model, 'muse-spark-1.3');
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, 'https://api.meta.ai/v1/chat/completions');
        assert.equal(calls[0]!.method, 'POST');
        assert.equal(calls[0]!.headers.authorization, `Bearer ${KEY}`);
        assert.equal(calls[0]!.redirect, 'error', 'a redirect would carry the key elsewhere');
        assert.equal(calls[0]!.body.reasoning_effort, 'low');
        assert.equal(calls[0]!.body.max_tokens, 4000);
        assert.ok(!calls[0]!.raw.includes(KEY));
        assert.equal(lines.filter((l) => l['event'] === 'llm.max_tokens_low').length, 0, '4 000 is the floor, so nothing is said');
    });

    it('warns, and goes ahead, when a call asks for less than Muse Spark needs to think: the limit, the floor and the model are in the line', async () => {
        capture();
        const { fetchImpl } = stubFetch(live('{"reply":"hi"}', { prompt_tokens: 15, completion_tokens: 190 }));
        await callLlm(args(fetchImpl, { maxTokens: 200 }));
        const warned = lines.filter((l) => l['event'] === 'llm.max_tokens_low');
        assert.equal(warned.length, 1);
        assert.deepEqual({ provider: warned[0]!['provider'], model: warned[0]!['model'], effort: warned[0]!['effort'], limit: warned[0]!['limit'], recommended: warned[0]!['recommended'] },
            { provider: 'meta', model: 'muse-spark-1.3', effort: 'low', limit: 200, recommended: 4000 });
    });

    it('fails a cut-off answer as max_tokens, final, billed for the thinking, and does not ask again', async () => {
        capture();
        const { fetchImpl, calls } = stubFetch(live(null, { prompt_tokens: 15, completion_tokens: 1000, completion_tokens_details: { reasoning_tokens: 1000 } }, 'length'), live('{"reply":"hi"}', {}));
        let err: AiError | undefined;
        try {
            await callLlm(args(fetchImpl, { maxTokens: 1000 }));
        } catch (caughtErr) {
            assert.ok(isAiError(caughtErr));
            err = caughtErr;
        }
        assert.ok(err, 'it failed');
        assert.equal(err.kind, 'max_tokens');
        assert.equal(err.retryable, false);
        assert.deepEqual(err.usage, { in: 15, out: 1000 });
        assert.equal(calls.length, 1);
    });

    it('sends a picture and the question that goes with it as one request, and reads the answer', async () => {
        capture();
        const { fetchImpl, calls } = stubFetch(live('{"reply":"a price screenshot"}', { prompt_tokens: 1075, completion_tokens: 564, completion_tokens_details: { reasoning_tokens: 506 } }));
        const out = await callLlm(args(fetchImpl, { user: [{ role: 'user', text: 'The customer shared the attached image and wrote nothing with it.', media: [IMAGE] }] }));
        assert.deepEqual(out.json, { reply: 'a price screenshot' });
        assert.deepEqual(out.usage, { in: 1075, out: 564 });
        const content = calls[0]!.body.messages[1].content;
        assert.deepEqual(content.map((p: { type: string }) => p.type), ['text', 'image_url']);
        assert.equal(content[1].image_url.url, 'data:image/jpeg;base64,SU1BR0VCWVRFUw==');
    });

    it('refuses media for any other provider before it asks anyone: no request, a final bad_request, and the file is in no error', async () => {
        for (const [provider, model] of [['anthropic', 'claude-opus-5-5'], ['openai', 'gpt-6-astra'], ['gemini', 'gemini-3.8-flash'], ['groq', 'openai/gpt-oss-120b'], ['openrouter', 'openrouter/auto']] as const) {
            const { fetchImpl, calls } = stubFetch(jsonResponse(200, {}));
            let err: AiError | undefined;
            try {
                await callLlm(args(fetchImpl, { provider, model, user: [{ role: 'user', text: 'see', media: [IMAGE] }] }));
            } catch (caughtErr) {
                assert.ok(isAiError(caughtErr));
                err = caughtErr;
            }
            assert.ok(err, provider);
            assert.equal(err.kind, 'bad_request', provider);
            assert.equal(err.retryable, false, provider);
            assert.equal(calls.length, 0, provider);
            assert.ok(!printed(err).includes(IMAGE.base64), provider);
        }
    });
});
