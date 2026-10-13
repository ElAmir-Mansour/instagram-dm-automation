/**
 * The error taxonomy: which HTTP answer is which kind, what is worth retrying, and that no
 * message that leaves this library carries the API key.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AI_ERROR_KINDS, AiError, errorFromHttp, MAX_MESSAGE_CHARS, RETRYABLE, scrub, type AiErrorKind } from './errors.js';

const KEY = 'sk-ant-api03-Zk3x9QvR7mT2pL8wNd5yHc1bVf4gJa6sUe0oIiXtKrMq';

const anthropicBody = (type: string, message: string) => JSON.stringify({ type: 'error', error: { type, message }, request_id: 'req_011CSHoEeqs5C35K2UUqR7Fy' });
const geminiBody = (code: number, status: string, message: string) => JSON.stringify({ error: { code, message, status } });
const openAiBody = (code: string, message: string) => JSON.stringify({ error: { message, type: 'insufficient_quota', code } });

describe('errorFromHttp', () => {
    // [what the provider sent, what it is]. Every row of the spec's table, with the wording each
    // provider really uses.
    const table: Array<[string, string, number, string, AiErrorKind]> = [
        ['Anthropic 401', 'anthropic', 401, anthropicBody('authentication_error', 'invalid x-api-key'), 'auth'],
        ['Anthropic 403', 'anthropic', 403, anthropicBody('permission_error', 'Your API key does not have permission to use the specified resource.'), 'auth'],
        ['Gemini 403', 'gemini', 403, geminiBody(403, 'PERMISSION_DENIED', 'Generative Language API has not been used in project 123 before or it is disabled.'), 'auth'],
        ['Gemini 400 key not valid', 'gemini', 400, geminiBody(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.'), 'auth'],
        ['Gemini 400 key expired', 'gemini', 400, geminiBody(400, 'INVALID_ARGUMENT', 'API key expired. Please renew the API key.'), 'auth'],
        ['Anthropic 402', 'anthropic', 402, anthropicBody('billing_error', 'There is an issue with your billing.'), 'quota'],
        ['402 with no body', 'openrouter', 402, '', 'quota'],
        ['OpenAI 429 insufficient_quota', 'openai', 429, openAiBody('insufficient_quota', 'You exceeded your current quota, please check your plan.'), 'quota'],
        ['Gemini 429 quota', 'gemini', 429, geminiBody(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota, please check your plan and billing details.'), 'quota'],
        ['429 mentioning billing', 'custom', 429, JSON.stringify({ error: 'Billing hard limit reached' }), 'quota'],
        ['Anthropic 400 empty credit balance', 'anthropic', 400, anthropicBody('invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.'), 'quota'],
        ['Anthropic 400 workspace spend limit', 'anthropic', 400, anthropicBody('invalid_request_error', 'You have reached your specified workspace API usage limits.'), 'quota'],
        ['Anthropic 429 rate limit', 'anthropic', 429, anthropicBody('rate_limit_error', "This request would exceed your organization's rate limit of 30,000 input tokens per minute."), 'rate'],
        ['429 with no body', 'openai', 429, '', 'rate'],
        ['Anthropic 400', 'anthropic', 400, anthropicBody('invalid_request_error', 'output_config.format: schema is not supported'), 'bad_request'],
        ['Gemini 400', 'gemini', 400, geminiBody(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.'), 'bad_request'],
        ['Anthropic 404', 'anthropic', 404, anthropicBody('not_found_error', 'model: claude-nope'), 'bad_request'],
        ['Gemini 404', 'gemini', 404, geminiBody(404, 'NOT_FOUND', 'models/gemini-9 is not found for API version v1beta'), 'bad_request'],
        ['Anthropic 413', 'anthropic', 413, anthropicBody('request_too_large', 'Request exceeds the maximum allowed number of bytes.'), 'bad_request'],
        ['422', 'custom', 422, JSON.stringify({ error: { message: 'bad json_schema' } }), 'bad_request'],
        ['408', 'custom', 408, '', 'timeout'],
        ['Anthropic 500', 'anthropic', 500, anthropicBody('api_error', 'Internal server error'), 'server'],
        ['Anthropic 529', 'anthropic', 529, anthropicBody('overloaded_error', 'Overloaded'), 'server'],
        ['Anthropic 504', 'anthropic', 504, anthropicBody('timeout_error', 'Request timed out'), 'server'],
        ['Gemini 503', 'gemini', 503, geminiBody(503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.'), 'server'],
        ['502 from a gateway', 'custom', 502, '<html><body>502 Bad Gateway</body></html>', 'server'],
    ];

    for (const [name, provider, status, body, kind] of table) {
        it(`maps ${name} to ${kind}`, () => {
            const err = errorFromHttp(provider, 'some-model', status, body);
            assert.equal(err.kind, kind);
            assert.equal(err.status, status);
            assert.equal(err.provider, provider);
            assert.equal(err.model, 'some-model');
            assert.equal(err.retryable, RETRYABLE[kind]);
        });
    }

    it('keeps the provider\'s own explanation as the message', () => {
        assert.equal(errorFromHttp('gemini', 'm', 400, geminiBody(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.')).message,
            'API key not valid. Please pass a valid API key.');
        assert.equal(errorFromHttp('anthropic', 'm', 529, anthropicBody('overloaded_error', 'Overloaded')).message, 'Overloaded');
        assert.equal(errorFromHttp('openai', 'm', 429, openAiBody('insufficient_quota', 'You exceeded your current quota.')).message, 'You exceeded your current quota.');
        // A string error, and Gemini's occasional array wrapper.
        assert.equal(errorFromHttp('custom', 'm', 500, JSON.stringify({ error: 'upstream exploded' })).message, 'upstream exploded');
        assert.equal(errorFromHttp('gemini', 'm', 500, JSON.stringify([{ error: { message: 'inside an array' } }])).message, 'inside an array');
    });

    it('says what happened when the body explains nothing, never printing a gateway\'s HTML', () => {
        assert.equal(errorFromHttp('anthropic', 'm', 502, '').message, 'Anthropic returned 502.');
        const html = errorFromHttp('custom', 'm', 502, '<html><body><h1>502 Bad Gateway</h1></body></html>');
        assert.equal(html.message, 'The custom endpoint returned 502.');
    });

    it('reads a quota out of OpenAI\'s error code even when the sentence does not say the word', () => {
        const body = JSON.stringify({ error: { message: 'Too many requests.', type: 'insufficient_quota', code: 'insufficient_quota' } });
        assert.equal(errorFromHttp('openai', 'm', 429, body).kind, 'quota');
    });

    it('does not mistake a malformed request that merely mentions an API key for a bad key', () => {
        const err = errorFromHttp('gemini', 'm', 400, geminiBody(400, 'INVALID_ARGUMENT', 'Unknown name "foo" at generation_config: Cannot find field.'));
        assert.equal(err.kind, 'bad_request');
    });

    it('scrubs the key out of what the provider says back', () => {
        const err = errorFromHttp('anthropic', 'm', 401, anthropicBody('authentication_error', `invalid x-api-key: ${KEY}`), KEY);
        assert.equal(err.kind, 'auth');
        assert.ok(!err.message.includes(KEY));
        assert.ok(!JSON.stringify(err).includes(KEY));
    });
});

describe('AiError', () => {
    it('carries kind, provider, model, status and whether it is retryable', () => {
        const err = new AiError({ kind: 'rate', provider: 'anthropic', model: 'claude-opus-5-5', status: 429, message: 'slow down' });
        assert.ok(err instanceof Error);
        assert.equal(err.name, 'AiError');
        assert.deepEqual(
            { kind: err.kind, provider: err.provider, model: err.model, status: err.status, retryable: err.retryable, message: err.message },
            { kind: 'rate', provider: 'anthropic', model: 'claude-opus-5-5', status: 429, retryable: true, message: 'slow down' },
        );
    });

    it('is retryable exactly where the spec says: rate, server, timeout, and bad_output once', () => {
        assert.deepEqual(
            Object.fromEntries(AI_ERROR_KINDS.map((k) => [k, RETRYABLE[k]])),
            {
                auth: false, quota: false, rate: true, bad_request: false, server: true, timeout: true,
                refusal: false, max_tokens: false, bad_output: true, budget: false, no_provider: false,
            },
        );
        for (const kind of AI_ERROR_KINDS) {
            assert.equal(new AiError({ kind, provider: 'p', model: 'm', message: 'x' }).retryable, RETRYABLE[kind]);
        }
    });

    it('has exactly the eleven kinds of the taxonomy', () => {
        assert.deepEqual([...AI_ERROR_KINDS].sort(), [
            'auth', 'bad_output', 'bad_request', 'budget', 'max_tokens', 'no_provider', 'quota', 'rate', 'refusal', 'server', 'timeout',
        ]);
    });

    it('scrubs its message in the constructor, so no construction site can forget', () => {
        const err = new AiError({ kind: 'auth', provider: 'anthropic', model: 'm', message: `bad key ${KEY}`, key: KEY });
        assert.equal(err.message, 'bad key [key]');
    });

    it('leaves nothing of the key in what a log line or a stack would print', () => {
        const err = new AiError({ kind: 'auth', provider: 'anthropic', model: 'm', status: 401, message: `rejected ${KEY} at ?key=${KEY}`, key: KEY });
        for (const printed of [JSON.stringify(err), String(err), err.message, err.stack ?? '']) {
            assert.ok(!printed.includes(KEY));
            assert.ok(!printed.includes(KEY.slice(0, 20)), printed);
        }
    });

    it('serialises its message, which an Error otherwise hides from JSON.stringify', () => {
        const err = new AiError({ kind: 'server', provider: 'gemini', model: 'm', status: 503, message: 'overloaded' });
        assert.deepEqual(JSON.parse(JSON.stringify(err)), {
            name: 'AiError', kind: 'server', provider: 'gemini', model: 'm', status: 503, retryable: true, message: 'overloaded',
        });
    });

    it('carries the tokens of an answer that was billed but unusable', () => {
        const err = new AiError({ kind: 'refusal', provider: 'anthropic', model: 'm', message: 'declined', usage: { input_tokens: 412, output_tokens: 0 } });
        assert.deepEqual(err.usage, { input_tokens: 412, output_tokens: 0 });
        assert.deepEqual(JSON.parse(JSON.stringify(err)).usage, { input_tokens: 412, output_tokens: 0 });
        assert.equal(new AiError({ kind: 'auth', provider: 'p', model: 'm', message: 'x' }).usage, undefined);
    });
});

describe('scrub', () => {
    it('removes the key itself, wherever it appears and however many times', () => {
        assert.equal(scrub(`first ${KEY}, then ${KEY}`, KEY), 'first [key], then [key]');
    });

    it('removes the key URL-encoded as well', () => {
        const key = 'abc+def/ghi=jkl mno';
        assert.equal(scrub(`GET /v1?key=${encodeURIComponent(key)} failed`, key).includes(encodeURIComponent(key)), false);
    });

    it('removes things shaped like keys even when it was not told which key', () => {
        const samples: Record<string, string> = {
            openai: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
            anthropic: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
            openrouter: 'sk-or-v1-0123456789abcdef0123456789abcdef',
            google: 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY',
            // Providers that mask the middle of a key still print its two ends.
            masked: 'sk-proj-********************abcd',
            xai: 'xai-' + 'A1b2C3d4'.repeat(10),
        };
        for (const [name, secret] of Object.entries(samples)) {
            const out = scrub(`Incorrect API key provided: ${secret}. You can find your key at the dashboard.`);
            assert.ok(!out.includes(secret), `${name}: ${out}`);
            assert.ok(out.includes('[redacted]'), `${name}: ${out}`);
            assert.ok(out.includes('Incorrect API key provided'), `${name}: the explanation survives: ${out}`);
        }
    });

    it('removes bearer tokens, keys in a query string and echoed credential headers', () => {
        const bearer = scrub('Authorization: Bearer abcDEF123456.token-value_xyz rejected');
        assert.ok(!bearer.includes('abcDEF123456'), bearer);
        const query = scrub('POST https://host/v1/models?key=AbC123xyz789&alt=json failed');
        assert.ok(!query.includes('AbC123xyz789'), query);
        assert.ok(query.includes('alt=json'), query);
        const header = scrub('request headers: x-goog-api-key: secretvalue12345, accept: json');
        assert.ok(!header.includes('secretvalue12345'), header);
    });

    it('leaves the sentences that explain an error readable', () => {
        for (const message of [
            'API key not valid. Please pass a valid API key.',
            'invalid x-api-key',
            "This request would exceed your organization's rate limit of 30,000 input tokens per minute.",
            'models/gemini-9 is not found for API version v1beta',
            'request_id req_011CSHoEeqs5C35K2UUqR7Fy',
        ]) {
            assert.equal(scrub(message), message);
        }
    });

    it('does not take a very short "key" for a credential, which would garble every word', () => {
        assert.equal(scrub('the answer is a', 'a'), 'the answer is a');
    });

    it('collapses whitespace and caps the message at 240 characters', () => {
        assert.equal(scrub('one\n\n  two\t three'), 'one two three');
        const long = scrub('word '.repeat(200));
        assert.equal(long.length, MAX_MESSAGE_CHARS);
        assert.ok(long.endsWith('…'));
        // Words, not a run of one letter: forty unbroken token characters read as a key.
        const sentence = (length: number) => `${'word '.repeat(60)}`.slice(0, length - 1) + 'x';
        assert.equal(scrub(sentence(240)), sentence(240));
        assert.equal(scrub(sentence(241)).length, 240);
    });

    it('removes the key before it cuts, so a key straddling the cut cannot survive as a prefix', () => {
        const padded = `${'x '.repeat(115)}${KEY}`; // the key starts a few characters before the 240th
        const out = scrub(padded, KEY);
        assert.ok(!out.includes(KEY.slice(0, 12)), out);
    });
});
