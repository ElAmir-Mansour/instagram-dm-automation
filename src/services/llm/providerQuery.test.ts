/**
 * "Load models" and "check this key" for every provider, against a stub `fetch`: which endpoint
 * each one calls, that the key is in exactly the header it belongs in and never in a URL, what a
 * list keeps and drops, how a failed check is mapped, and the front door's own rules.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_QUERY_TIMEOUT_MS } from './adapters/endpoint.js';
import type { FamilyAdapters } from './adapters/index.js';
import { AiError, isAiError } from './errors.js';
import { checkProviderKey, listProviderModels } from './providerQuery.js';
import type { ProviderId } from './registry.js';
import { hangingFetch, jsonResponse, stubFetch } from './testFetch.js';
import type { FetchLike, ProviderQuery } from './types.js';

const KEYS = {
    anthropic: 'sk-ant-api03-Zk3x9QvR7mT2pL8wNd5yHc1bVf4gJa6sUe0oIiXtKrMq',
    openai: 'sk-proj-Tq8vLm2xWz4RnYb7KdP1aHc6JfSe9UoNgIiXtVrBwEs3',
    gemini: 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY',
    openrouter: 'sk-or-v1-' + '3f9a'.repeat(16),
    custom: 'llm-key-Zk3x9QvR7mT2pL8wNd5yHc1bVf4gJa6sUe0oIiXtKrMq',
} satisfies Record<ProviderId, string>;
const CUSTOM_BASE = 'https://llm.example.com/v1';

const query = (provider: ProviderId, fetchImpl: FetchLike, over: Partial<ProviderQuery> = {}): ProviderQuery => ({
    provider, apiKey: KEYS[provider], fetchImpl, ...(provider === 'custom' ? { baseUrl: CUSTOM_BASE } : {}), ...over,
});

async function rejection(promise: Promise<unknown>): Promise<AiError> {
    try {
        await promise;
    } catch (err) {
        assert.ok(isAiError(err), `expected an AiError, got ${String(err)}`);
        return err;
    }
    return assert.fail('expected the call to fail');
}

/** Every way an error object can be turned into text. */
const printed = (err: AiError): string => [JSON.stringify(err), String(err), err.message, err.stack ?? ''].join('\n');

// ─── What each provider answers ──────────────────────────────────────────────────────────────

const anthropicList = () => jsonResponse(200, {
    data: [
        { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-21T00:00:00Z', lifecycle: 'active' },
        { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-09-21T00:00:00Z', lifecycle: 'active' },
        { type: 'model', id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-05-01T00:00:00Z', lifecycle: 'deprecated' },
    ],
    first_id: 'claude-opus-5-5', has_more: false, last_id: 'claude-opus-4-8',
});

const openaiList = () => jsonResponse(200, {
    object: 'list',
    data: [
        { id: 'gpt-6-luna', object: 'model', created: 1789000000, owned_by: 'system' },
        { id: 'text-embedding-3-large', object: 'model', created: 1790500000, owned_by: 'system' },
        { id: 'gpt-6.1-sol', object: 'model', created: 1791000000, owned_by: 'system' },
        { id: 'whisper-1', object: 'model', created: 1700000000, owned_by: 'openai-internal' },
        { id: 'gpt-6-astra', object: 'model', created: 1790000000, owned_by: 'system' },
        { id: 'gpt-image-2.5-sunburst', object: 'model', created: 1790700000, owned_by: 'system' },
        { id: 'gpt-4o-mini-tts', object: 'model', created: 1742000000, owned_by: 'system' },
        { id: 'gpt-realtime-2.1', object: 'model', created: 1790800000, owned_by: 'system' },
        { id: 'omni-moderation-latest', object: 'model', created: 1727000000, owned_by: 'system' },
        { id: 'gpt-6-astra', object: 'model', created: 1790000000, owned_by: 'system' },
        { id: 'o3', object: 'model', created: 1744000000, owned_by: 'system' },
        { id: 'o3-deep-research', object: 'model', created: 1745000000, owned_by: 'system' },
        { id: 'o4-mini-deep-research-2025-06-26', object: 'model', created: 1746000000, owned_by: 'system' },
        { id: 'gpt-3.5-turbo-instruct', object: 'model', created: 1695000000, owned_by: 'system' },
        { id: 'gpt-5.1-instruct-2026-01-15', object: 'model', created: 1747000000, owned_by: 'system' },
    ],
});

const geminiList = () => jsonResponse(200, {
    models: [
        { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/text-embedding-004', displayName: 'Text Embedding 004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/imagen-4.0-generate', displayName: 'Imagen 4', supportedGenerationMethods: ['predict'] },
    ],
});

const openrouterList = () => jsonResponse(200, {
    data: [
        { id: 'openrouter/auto', name: 'Auto Router', supported_parameters: ['max_tokens', 'response_format', 'structured_outputs', 'reasoning'], architecture: { output_modalities: ['text', 'image'] } },
        { id: 'anthropic/claude-opus-5.5', supported_parameters: ['max_tokens', 'structured_outputs'], architecture: { output_modalities: ['text'] } },
        { id: 'scaledown/summarize', supported_parameters: ['max_tokens'], architecture: { output_modalities: ['text'] } },
        { id: 'black-forest-labs/flux-3', supported_parameters: ['structured_outputs'], architecture: { output_modalities: ['image'] } },
        { id: 'google/gemini-3.8-flash', supported_parameters: ['max_tokens', 'structured_outputs'], architecture: { output_modalities: ['text'] } },
        { id: 'anthropic/claude-opus-5.5', supported_parameters: ['max_tokens', 'structured_outputs'], architecture: { output_modalities: ['text'] } },
        { id: 'some/model-with-no-fields' },
    ],
    total_count: 7,
});

const customList = () => jsonResponse(200, { object: 'list', data: [{ id: 'llama-4-maverick', object: 'model' }, { id: 'qwen-4-72b', object: 'model' }] });

const openRouterKey = () => jsonResponse(200, { data: { label: 'sk-or-v1-abc...f3a', limit: null, limit_remaining: null, usage: 1.25, is_free_tier: false } });

/** One row per provider: the answer to its list, what a list should come to, and where each call goes. */
const rows: Array<{
    provider: ProviderId; list: () => Response; models: string[]; listUrl: string; checkUrl: string; header: string; value: (key: string) => string;
}> = [
    {
        provider: 'anthropic', list: anthropicList, models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-4-8'],
        listUrl: 'https://api.anthropic.com/v1/models?limit=1000', checkUrl: 'https://api.anthropic.com/v1/models?limit=1', header: 'x-api-key', value: (k) => k,
    },
    {
        provider: 'openai', list: openaiList, models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'o3'],
        listUrl: 'https://api.openai.com/v1/models', checkUrl: 'https://api.openai.com/v1/models', header: 'authorization', value: (k) => `Bearer ${k}`,
    },
    {
        provider: 'gemini', list: geminiList, models: ['gemini-3.8-flash', 'gemini-3.1-pro-preview'],
        listUrl: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', checkUrl: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
        header: 'x-goog-api-key', value: (k) => k,
    },
    {
        provider: 'custom', list: customList, models: ['llama-4-maverick', 'qwen-4-72b'],
        listUrl: `${CUSTOM_BASE}/models`, checkUrl: `${CUSTOM_BASE}/models`, header: 'authorization', value: (k) => `Bearer ${k}`,
    },
];

describe('listProviderModels', () => {
    for (const row of rows) {
        it(`${row.provider}: one GET to ${row.listUrl}, with the key in ${row.header}, and the ids it offers`, async () => {
            const { fetchImpl, calls } = stubFetch(row.list());
            assert.deepEqual(await listProviderModels(query(row.provider, fetchImpl)), row.models);
            assert.equal(calls.length, 1);
            assert.equal(calls[0]!.method, 'GET');
            assert.equal(calls[0]!.url, row.listUrl);
            assert.equal(calls[0]!.headers[row.header], row.value(KEYS[row.provider]));
            assert.equal(calls[0]!.raw, '');
        });
    }

    it('openai: drops what cannot write text (embeddings, speech, images, realtime, moderation, deep research, instruct), and puts the newest first', async () => {
        const { fetchImpl } = stubFetch(openaiList());
        const models = await listProviderModels(query('openai', fetchImpl));
        assert.deepEqual(models, ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'o3']);
        for (const gone of ['text-embedding-3-large', 'whisper-1', 'gpt-image-2.5-sunburst', 'gpt-4o-mini-tts', 'gpt-realtime-2.1', 'omni-moderation-latest', 'o3-deep-research', 'o4-mini-deep-research-2025-06-26', 'gpt-3.5-turbo-instruct', 'gpt-5.1-instruct-2026-01-15']) {
            assert.ok(!models.includes(gone), gone);
        }
    });

    it('openai: keeps the order it was given for ids that carry no date, and does not mind an entry with no id', async () => {
        const { fetchImpl } = stubFetch(jsonResponse(200, { data: [{ id: 'b-model' }, { object: 'model' }, { id: 'a-model' }, null, { id: 42 }] }));
        assert.deepEqual(await listProviderModels(query('openai', fetchImpl)), ['b-model', 'a-model']);
    });

    it('gemini: lists only models that can generateContent, without the models/ prefix; one with no methods listed is kept', async () => {
        const { fetchImpl } = stubFetch(jsonResponse(200, { models: [{ name: 'models/old-model' }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }] }));
        assert.deepEqual(await listProviderModels(query('gemini', fetchImpl)), ['old-model']);
    });

    it('anthropic: keeps the order it was given, newest first', async () => {
        const { fetchImpl } = stubFetch(anthropicList());
        assert.deepEqual(await listProviderModels(query('anthropic', fetchImpl)), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-4-8']);
    });

    describe('openrouter', () => {
        it('reads the public list without a key, and sends it none', async () => {
            const { fetchImpl, calls } = stubFetch(openrouterList());
            const models = await listProviderModels(query('openrouter', fetchImpl, { apiKey: '' }));
            assert.ok(models.length > 0);
            assert.equal(calls[0]!.url, 'https://openrouter.ai/api/v1/models');
            assert.ok(!('authorization' in calls[0]!.headers));
        });

        it('does not send the key it has either: the list is public, so there is nothing for it to prove', async () => {
            const { fetchImpl, calls } = stubFetch(openrouterList());
            await listProviderModels(query('openrouter', fetchImpl));
            assert.ok(!('authorization' in calls[0]!.headers));
            assert.ok(!calls[0]!.raw.includes(KEYS.openrouter));
        });

        it('keeps the models that can answer in a schema and write text, once each, and the ones whose fields are not there to judge', async () => {
            const { fetchImpl } = stubFetch(openrouterList());
            assert.deepEqual(await listProviderModels(query('openrouter', fetchImpl)), ['openrouter/auto', 'anthropic/claude-opus-5.5', 'google/gemini-3.8-flash', 'some/model-with-no-fields']);
        });
    });

    describe('custom', () => {
        it('reads the other shapes a compatible server sends: {models: [...]}, a bare array, plain strings, names for ids', async () => {
            for (const body of [{ models: [{ id: 'a' }, { id: 'b' }] }, [{ id: 'a' }, { id: 'b' }], ['a', 'b'], { data: [{ name: 'a' }, { name: 'b' }] }, { data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }]) {
                const { fetchImpl } = stubFetch(jsonResponse(200, body));
                assert.deepEqual(await listProviderModels(query('custom', fetchImpl)), ['a', 'b'], JSON.stringify(body));
            }
            // Nothing it can read is an empty list, not a failure.
            assert.deepEqual(await listProviderModels(query('custom', stubFetch(jsonResponse(200, { ok: true })).fetchImpl)), []);
        });

        it('works without a key and sends no authorization header, for an open endpoint', async () => {
            const { fetchImpl, calls } = stubFetch(customList());
            assert.deepEqual(await listProviderModels(query('custom', fetchImpl, { apiKey: '' })), ['llama-4-maverick', 'qwen-4-72b']);
            assert.ok(!('authorization' in calls[0]!.headers));
        });

        it('says so when the endpoint has no list: a 404 is a bad_request that tells the operator to type the id', async () => {
            const { fetchImpl, calls } = stubFetch(jsonResponse(404, { error: { message: 'Not found' } }));
            const err = await rejection(listProviderModels(query('custom', fetchImpl)));
            assert.equal(err.kind, 'bad_request');
            assert.equal(err.status, 404);
            assert.match(err.message, /no model list/);
            assert.match(err.message, /Type the model id/);
            assert.equal(calls.length, 1);
        });

        it('tidies the base URL it was given, and hits /models under it', async () => {
            const { fetchImpl, calls } = stubFetch(customList());
            await listProviderModels(query('custom', fetchImpl, { baseUrl: '  https://llm.example.com/openai/v1/  ' }));
            assert.equal(calls[0]!.url, 'https://llm.example.com/openai/v1/models');
        });
    });

    it('is the models the provider says, whatever base URL a provider with its own address is offered', async () => {
        for (const row of rows.filter((r) => r.provider !== 'custom')) {
            const { fetchImpl, calls } = stubFetch(row.list());
            await listProviderModels(query(row.provider, fetchImpl, { baseUrl: 'https://evil.example.com/v1' }));
            assert.equal(calls[0]!.url, row.listUrl, row.provider);
        }
    });
});

describe('checkProviderKey', () => {
    for (const row of rows) {
        it(`${row.provider}: one GET to ${row.checkUrl}, with the key in ${row.header}, and passes`, async () => {
            const { fetchImpl, calls } = stubFetch(row.list());
            assert.deepEqual(await checkProviderKey(query(row.provider, fetchImpl)), { ok: true });
            assert.equal(calls.length, 1);
            assert.equal(calls[0]!.method, 'GET');
            assert.equal(calls[0]!.url, row.checkUrl);
            assert.equal(calls[0]!.headers[row.header], row.value(KEYS[row.provider]));
        });
    }

    describe('openrouter', () => {
        it('asks /key, which answers about the key, and never /models, which answers about nothing', async () => {
            const { fetchImpl, calls } = stubFetch(openRouterKey());
            assert.deepEqual(await checkProviderKey(query('openrouter', fetchImpl)), { ok: true });
            assert.equal(calls.length, 1);
            assert.equal(calls[0]!.url, 'https://openrouter.ai/api/v1/key');
            assert.equal(calls[0]!.headers['authorization'], `Bearer ${KEYS.openrouter}`);
        });

        it('fails a key that /key refuses, although /models would have said yes', async () => {
            const routed: FetchLike = async (url) =>
                url.endsWith('/models') ? openrouterList() : jsonResponse(401, { error: { code: 401, message: 'No auth credentials found' } });
            const err = await rejection(checkProviderKey(query('openrouter', routed)));
            assert.equal(err.kind, 'auth');
            assert.equal(err.status, 401);
            assert.equal(err.provider, 'openrouter');
        });

        it('needs a key: with none there is nothing to check, and no request is made', async () => {
            const { fetchImpl, calls } = stubFetch(openRouterKey());
            const err = await rejection(checkProviderKey(query('openrouter', fetchImpl, { apiKey: '  ' })));
            assert.equal(err.kind, 'no_provider');
            assert.equal(calls.length, 0);
        });

        // /key answers 200 and says how much is left: `limit_remaining` is a number, or null for a key with no limit.
        const keyWith = (data: Record<string, unknown>) => stubFetch(jsonResponse(200, { data: { label: 'sk-or-v1-abc...f3a', limit: 10, usage: 10, is_free_tier: false, ...data } })).fetchImpl;

        it('passes a key that works but has no credit left, with the warning no_credit', async () => {
            for (const limit_remaining of [0, -0.25, -1e-9]) {
                assert.deepEqual(await checkProviderKey(query('openrouter', keyWith({ limit_remaining }))), { ok: true, warning: 'no_credit' }, String(limit_remaining));
            }
        });

        it('passes a key with credit left, or with no limit, with no warning', async () => {
            for (const limit_remaining of [0.01, 5, 1000, null]) {
                assert.deepEqual(await checkProviderKey(query('openrouter', keyWith({ limit_remaining }))), { ok: true }, String(limit_remaining));
            }
            // Missing, or not a number: nothing to warn about.
            assert.deepEqual(await checkProviderKey(query('openrouter', keyWith({}))), { ok: true });
            assert.deepEqual(await checkProviderKey(query('openrouter', keyWith({ limit_remaining: '0' }))), { ok: true });
            assert.deepEqual(await checkProviderKey(query('openrouter', stubFetch(jsonResponse(200, {})).fetchImpl)), { ok: true });
        });
    });

    describe('custom', () => {
        it('passes with a warning when the endpoint has no /models: it cannot say whether the key is good', async () => {
            const { fetchImpl, calls } = stubFetch(jsonResponse(404, { error: { message: 'Not found' } }));
            assert.deepEqual(await checkProviderKey(query('custom', fetchImpl)), { ok: true, warning: 'no_model_list' });
            assert.equal(calls.length, 1);
        });

        it('passes with no warning when there is a list, even an empty one', async () => {
            assert.deepEqual(await checkProviderKey(query('custom', stubFetch(jsonResponse(200, { data: [] })).fetchImpl)), { ok: true });
        });

        it('fails a key the endpoint refuses, and an endpoint that errors: only a 404 is "no list"', async () => {
            for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [429, 'rate'], [500, 'server'], [502, 'server'], [400, 'bad_request']] as const) {
                const err = await rejection(checkProviderKey(query('custom', stubFetch(jsonResponse(status, { error: { message: 'no' } })).fetchImpl)));
                assert.equal(err.kind, kind, String(status));
            }
        });

        it('does not need a key', async () => {
            const { fetchImpl, calls } = stubFetch(customList());
            assert.deepEqual(await checkProviderKey(query('custom', fetchImpl, { apiKey: '' })), { ok: true });
            assert.ok(!('authorization' in calls[0]!.headers));
        });
    });

    describe('what a failed check says, for every provider', () => {
        const refusals: Array<[ProviderId, number, unknown, string]> = [
            ['anthropic', 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'auth'],
            ['anthropic', 403, { type: 'error', error: { type: 'permission_error', message: 'not allowed' } }, 'auth'],
            ['openai', 401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } }, 'auth'],
            ['openai', 403, { error: { message: 'You have insufficient permissions for this operation.', type: 'invalid_request_error', code: null } }, 'auth'],
            ['gemini', 400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }, 'auth'],
            ['gemini', 403, { error: { code: 403, message: 'Permission denied', status: 'PERMISSION_DENIED' } }, 'auth'],
            ['openrouter', 401, { error: { code: 401, message: 'No auth credentials found' } }, 'auth'],
        ];
        for (const [provider, status, body, kind] of refusals) {
            it(`${provider} ${status} is ${kind}, final, and names the provider but no model`, async () => {
                const { fetchImpl, calls } = stubFetch(jsonResponse(status, body));
                const err = await rejection(checkProviderKey(query(provider, fetchImpl)));
                assert.equal(err.kind, kind);
                assert.equal(err.status, status);
                assert.equal(err.provider, provider);
                assert.equal(err.model, '');
                assert.equal(err.retryable, false);
                assert.equal(calls.length, 1);
            });
        }

        it('maps the rest of the taxonomy the same way a generate call does', async () => {
            const cases: Array<[number, unknown, string, boolean]> = [
                [429, { error: { message: 'Slow down', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }, 'rate', true],
                [429, { error: { message: 'Out of credit.', type: 'insufficient_quota', code: 'insufficient_quota' } }, 'quota', false],
                [500, { error: { message: 'oops' } }, 'server', true],
                [503, { error: { message: 'overloaded' } }, 'server', true],
            ];
            for (const [status, body, kind, retryable] of cases) {
                const err = await rejection(checkProviderKey(query('openai', stubFetch(jsonResponse(status, body)).fetchImpl)));
                assert.equal(err.kind, kind, String(status));
                assert.equal(err.retryable, retryable);
            }
        });
    });
});

// OpenRouter's list never sends the key (it is public), but its check does, to /key.
const openrouterCheck = {
    provider: 'openrouter' as ProviderId, list: openRouterKey, models: [] as string[], listUrl: '', checkUrl: 'https://openrouter.ai/api/v1/key',
    header: 'authorization', value: (k: string) => `Bearer ${k}`,
};

describe('the key, in every list and check', () => {
    for (const [what, run] of [['listProviderModels', listProviderModels], ['checkProviderKey', checkProviderKey]] as const) {
        for (const row of what === 'checkProviderKey' ? [...rows, openrouterCheck] : rows) {
            describe(`${row.provider} ${what}`, () => {
                const key = KEYS[row.provider];

                it('travels in exactly one request header, and in no URL', async () => {
                    const { fetchImpl, calls } = stubFetch(row.list());
                    await run(query(row.provider, fetchImpl));
                    assert.deepEqual(Object.entries(calls[0]!.headers).filter(([, v]) => v.includes(key)).map(([k]) => k), [row.header]);
                    assert.ok(!calls[0]!.url.includes(key));
                    assert.ok(!calls[0]!.url.includes('key='));
                    assert.ok(!calls[0]!.raw.includes(key));
                });

                it('is trimmed first, so a pasted newline cannot break a header', async () => {
                    const { fetchImpl, calls } = stubFetch(row.list());
                    await run(query(row.provider, fetchImpl, { apiKey: `  ${key}\n` }));
                    assert.equal(calls[0]!.headers[row.header], row.value(key));
                });

                it('goes with a request that refuses redirects, which would carry the header elsewhere', async () => {
                    const { fetchImpl, calls } = stubFetch(row.list());
                    await run(query(row.provider, fetchImpl));
                    assert.equal(calls[0]!.redirect, 'error');
                });

                it('is nowhere in an error, even when the provider echoes it back', async () => {
                    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
                        const echo = `Invalid credential ${key} (request to /v1?key=${key} with x-api-key: ${key}; Bearer ${key})`;
                        const { fetchImpl } = stubFetch(jsonResponse(status, { error: { message: echo } }));
                        let err: AiError;
                        try {
                            await run(query(row.provider, fetchImpl));
                            // Custom's 404 is not an error for a check; there is nothing to look at.
                            continue;
                        } catch (caught) {
                            assert.ok(isAiError(caught));
                            err = caught;
                        }
                        assert.ok(!printed(err).includes(key), `${status}: ${printed(err)}`);
                        assert.ok(!printed(err).includes(key.slice(5, 30)), `${status}: a piece survived`);
                    }
                });

                it('is nowhere in the error for a refused redirect, a dropped connection or a body that is not JSON', async () => {
                    const failures: FetchLike[] = [
                        stubFetch(Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') })).fetchImpl,
                        stubFetch(Object.assign(new TypeError(`fetch failed for ${key}`), { cause: { code: 'ECONNRESET' } })).fetchImpl,
                        stubFetch(new Response(`<html>${key}</html>`, { status: 200 })).fetchImpl,
                        stubFetch(new Response(`gateway down ${key}`, { status: 502 })).fetchImpl,
                    ];
                    for (const fetchImpl of failures) {
                        const err = await rejection(run(query(row.provider, fetchImpl)));
                        assert.ok(!printed(err).includes(key), printed(err));
                    }
                });
            });
        }
    }

    it('a refused redirect is bad_request and final, and the 307\'s target is never contacted', async () => {
        const { fetchImpl, calls } = stubFetch(new Response('', { status: 307, headers: { location: 'https://evil.example.com/' } }), customList());
        const err = await rejection(checkProviderKey(query('custom', fetchImpl)));
        assert.equal(err.kind, 'bad_request');
        assert.equal(err.status, 307);
        assert.equal(calls.length, 1);
    });
});

describe('the front door', () => {
    it('refuses a provider that does not exist, before any request', async () => {
        const { fetchImpl, calls } = stubFetch(customList());
        for (const run of [listProviderModels, checkProviderKey]) {
            const err = await rejection(run({ provider: 'groq' as ProviderId, apiKey: 'k', fetchImpl }));
            assert.equal(err.kind, 'bad_request');
            assert.match(err.message, /Unknown AI provider "groq"/);
        }
        assert.equal(calls.length, 0);
    });

    it('is no_provider for a provider that needs a key and has none, before any request', async () => {
        for (const provider of ['anthropic', 'openai', 'gemini'] as const) {
            for (const run of [listProviderModels, checkProviderKey]) {
                const { fetchImpl, calls } = stubFetch(anthropicList());
                const err = await rejection(run(query(provider, fetchImpl, { apiKey: '   ' })));
                assert.equal(err.kind, 'no_provider', provider);
                assert.equal(err.retryable, false);
                assert.equal(calls.length, 0);
            }
        }
        assert.match((await rejection(checkProviderKey({ provider: 'openai', apiKey: '', fetchImpl: stubFetch().fetchImpl }))).message, /No API key is saved for OpenAI/);
    });

    it('checks Custom\'s base URL for every list and every check, and sends nothing to one that fails', async () => {
        for (const baseUrl of [undefined, '', '   ', 'http://llm.example.com/v1', 'https://10.0.0.5/v1', 'https://169.254.169.254/latest', 'https://localhost:11434/v1', 'https://box.local', 'https://u:p@llm.example.com', 'https://llm.example.com/v1?x=1', 'not a url']) {
            for (const run of [listProviderModels, checkProviderKey]) {
                const { fetchImpl, calls } = stubFetch(customList());
                const err = await rejection(run(query('custom', fetchImpl, { baseUrl })));
                assert.equal(err.kind, 'bad_request', String(baseUrl));
                assert.ok(!printed(err).includes(KEYS.custom));
                assert.equal(calls.length, 0, String(baseUrl));
            }
        }
    });

    it('gives a call with no deadline of its own one, and uses the caller\'s when it has one', async () => {
        assert.equal(DEFAULT_QUERY_TIMEOUT_MS, 15_000);
        const mine = stubFetch(anthropicList());
        await listProviderModels(query('anthropic', mine.fetchImpl));
        assert.ok(mine.calls[0]!.signal instanceof AbortSignal);
        assert.equal(mine.calls[0]!.signal!.aborted, false);

        const controller = new AbortController();
        const theirs = stubFetch(anthropicList());
        await checkProviderKey(query('anthropic', theirs.fetchImpl, { signal: controller.signal }));
        assert.equal(theirs.calls[0]!.signal, controller.signal);
    });

    it('is timeout, retryable, for a server that never answers, once the caller\'s deadline passes', async () => {
        for (const run of [listProviderModels, checkProviderKey]) {
            const started = Date.now();
            const err = await rejection(run(query('openai', hangingFetch, { signal: AbortSignal.timeout(30) })));
            assert.equal(err.kind, 'timeout');
            assert.equal(err.retryable, true);
            assert.ok(Date.now() - started < 2000);
        }
    });

    it('is bad_output for a 200 that is not JSON, and timeout for a connection that cannot be made', async () => {
        const html = await rejection(listProviderModels(query('openai', stubFetch(new Response('<html>maintenance</html>', { status: 200 })).fetchImpl)));
        assert.equal(html.kind, 'bad_output');
        const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
        const down = await rejection(checkProviderKey(query('gemini', stubFetch(refused).fetchImpl)));
        assert.equal(down.kind, 'timeout');
        assert.match(down.message, /ENOTFOUND/);
    });

    it('scrubs with the key as it was sent, trimmed: a padded key is still found in what a failure says', async () => {
        const padded = `  ${KEYS.openai}\n`;
        const throwing = (error: unknown): FamilyAdapters => ({ openai_responses: { generate: async () => assert.fail('not called'), listModels: async () => { throw error; }, checkKey: async () => { throw error; } } });
        for (const run of [listProviderModels, checkProviderKey]) {
            const bug = await rejection(run(query('openai', stubFetch().fetchImpl, { apiKey: padded }), throwing(new TypeError(`boom ${KEYS.openai} boom`))));
            assert.ok(!printed(bug).includes(KEYS.openai), printed(bug));
            assert.match(bug.message, /\[key\]/);
        }
        // Also when the family has nothing to run, and when the provider is not one.
        const none = await rejection(listProviderModels(query('openai', stubFetch().fetchImpl, { apiKey: padded }), { openai_responses: { generate: async () => assert.fail('not called') } }));
        assert.ok(!printed(none).includes(KEYS.openai));
    });

    it('lets an AiError from the adapter through as it was, and turns anything else into one, scrubbed of the key', async () => {
        const own = new AiError({ kind: 'quota', provider: 'openai', model: '', message: 'spent' });
        const throwing = (error: unknown): FamilyAdapters => ({ openai_responses: { generate: async () => assert.fail('not called'), listModels: async () => { throw error; }, checkKey: async () => { throw error; } } });
        assert.equal(await rejection(listProviderModels(query('openai', stubFetch().fetchImpl), throwing(own))), own);

        const bug = await rejection(checkProviderKey(query('openai', stubFetch().fetchImpl), throwing(new TypeError(`x.map is not a function near ${KEYS.openai}`))));
        assert.equal(bug.kind, 'bad_request');
        assert.equal(bug.retryable, false);
        assert.match(bug.message, /Unexpected failure: x\.map is not a function/);
        assert.ok(!printed(bug).includes(KEYS.openai));

        const aborted = await rejection(listProviderModels(query('openai', stubFetch().fetchImpl), throwing(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))));
        assert.equal(aborted.kind, 'timeout');
    });

    it('says so, as a bad_request, when a family has no list or no check, or no adapter at all', async () => {
        const bare: FamilyAdapters = { openai_responses: { generate: async () => assert.fail('not called') } };
        const noList = await rejection(listProviderModels(query('openai', stubFetch().fetchImpl), bare));
        assert.equal(noList.kind, 'bad_request');
        assert.match(noList.message, /no model list/);
        const noCheck = await rejection(checkProviderKey(query('openai', stubFetch().fetchImpl), bare));
        assert.match(noCheck.message, /no key check/);
        const none = await rejection(checkProviderKey(query('gemini', stubFetch().fetchImpl), bare));
        assert.equal(none.kind, 'bad_request');
        assert.match(none.message, /no adapter for the gemini family/);
    });
});
