/**
 * The error taxonomy: which HTTP answer is which kind, what is worth retrying, and that no
 * message that leaves this library carries the API key.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeError } from '../../utils/log.js';
import {
    AI_ERROR_KINDS, aiErrorLogFields, AiError, errorFromHttp, MAX_MESSAGE_CHARS, parseRetryAfter, RETRYABLE, scrub, type AiErrorKind,
} from './errors.js';

const KEY = 'sk-ant-api03-Zk3x9QvR7mT2pL8wNd5yHc1bVf4gJa6sUe0oIiXtKrMq';

const anthropicBody = (type: string, message: string, details?: unknown) =>
    JSON.stringify({ type: 'error', error: { type, message, ...(details ? { details } : {}) }, request_id: 'req_011CSHoEeqs5C35K2UUqR7Fy' });
const geminiBody = (code: number, status: string, message: string, details?: unknown[]) =>
    JSON.stringify({ error: { code, message, status, ...(details ? { details } : {}) } });
const openAiBody = (code: string, message: string) => JSON.stringify({ error: { message, type: 'insufficient_quota', code } });

// Google's structured 429 detail: which quota was hit, and how long to wait.
const quotaFailure = (...quotaIds: string[]) => ({
    '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
    violations: quotaIds.map((quotaId) => ({
        quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId,
        quotaDimensions: { location: 'global', model: 'gemini-3.8-flash' }, quotaValue: '20',
    })),
});
const retryInfo = (retryDelay: string) => ({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay });
// The sentence is the same for a per-minute and a per-day limit, which is the whole problem.
const GEMINI_QUOTA_WORDS = 'You exceeded your current quota, please check your plan and billing details.';
const PER_DAY = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier';
const PER_MINUTE = 'GenerateContentInputTokensPerModelPerMinute-FreeTier';

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
        ['Anthropic 400 empty credit balance', 'anthropic', 400, anthropicBody('invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.'), 'quota'],
        ['Anthropic 400 workspace spend limit', 'anthropic', 400, anthropicBody('invalid_request_error', 'You have reached your specified workspace API usage limits.'), 'quota'],
        ['Anthropic 400', 'anthropic', 400, anthropicBody('invalid_request_error', 'output_config.format: schema is not supported'), 'bad_request'],
        ['Gemini 400', 'gemini', 400, geminiBody(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.'), 'bad_request'],
        ['Anthropic 404', 'anthropic', 404, anthropicBody('not_found_error', 'model: claude-nope'), 'bad_request'],
        ['Gemini 404', 'gemini', 404, geminiBody(404, 'NOT_FOUND', 'models/gemini-9 is not found for API version v1beta'), 'bad_request'],
        ['Anthropic 413', 'anthropic', 413, anthropicBody('request_too_large', 'Request exceeds the maximum allowed number of bytes.'), 'bad_request'],
        ['422', 'custom', 422, JSON.stringify({ error: { message: 'bad json_schema' } }), 'bad_request'],
        ['a redirect', 'custom', 307, '', 'bad_request'],
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

    describe('a 403', () => {
        const body = (error: Record<string, unknown>) => JSON.stringify({ error });
        // OpenRouter's 403 is "insufficient permissions, a guardrail block, or a moderation flag", and the body says which.
        const rows: Array<[string, string, string, AiErrorKind]> = [
            ['a key that may not do this', 'openrouter', body({ code: 403, message: 'Insufficient permissions' }), 'auth'],
            ['no body at all', 'openrouter', '', 'auth'],
            ['a moderation flag, by metadata.reasons', 'openrouter', body({ code: 403, message: 'Your input was flagged', metadata: { reasons: ['hate'], flagged_input: 'text', provider_name: 'OpenAI', model_slug: 'openai/gpt-6-astra' } }), 'refusal'],
            ['a moderation flag, by metadata.flagged_input alone', 'openrouter', body({ code: 403, message: 'Flagged', metadata: { flagged_input: 'text' } }), 'refusal'],
            ['a guardrail, by its words', 'openrouter', body({ code: 403, message: 'This request was blocked by a guardrail policy' }), 'refusal'],
            ['a guardrail, by a metadata key', 'openrouter', body({ code: 403, message: 'Blocked', metadata: { guardrail_name: 'no-pii' } }), 'refusal'],
            ['a spent key limit, by metadata.limit_source', 'openrouter', body({ code: 403, message: 'Key limit exceeded', metadata: { limit_source: 'openrouter_key_limit' } }), 'quota'],
            ['a budget, ahead of a moderation field', 'openrouter', body({ code: 403, message: 'Budget', metadata: { limit_source: 'openrouter_in_flight_budget', reasons: ['x'] } }), 'quota'],
            ['metadata that says nothing', 'openrouter', body({ code: 403, message: 'No', metadata: { provider_name: 'OpenAI' } }), 'auth'],
            // Only OpenRouter's bodies mean these things: everyone else's 403 is a key.
            ['the same moderation fields from another provider', 'openai', body({ message: 'Nope', metadata: { reasons: ['x'] } }), 'auth'],
            ['the same fields from a custom endpoint', 'custom', body({ message: 'guardrail', metadata: { limit_source: 'x' } }), 'auth'],
            ['Anthropic', 'anthropic', JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Not allowed' } }), 'auth'],
            ['Gemini', 'gemini', geminiBody(403, 'PERMISSION_DENIED', 'Permission denied'), 'auth'],
        ];
        for (const [name, provider, text, kind] of rows) {
            it(`${name} is ${kind}`, () => {
                const err = errorFromHttp(provider, 'm', 403, text);
                assert.equal(err.kind, kind);
                assert.equal(err.status, 403);
                assert.equal(err.retryable, false);
                assert.equal(err.retryAfterMs, undefined);
            });
        }

        it('keeps what the provider said, whichever kind it is', () => {
            assert.equal(errorFromHttp('openrouter', 'm', 403, body({ code: 403, message: 'Your input was flagged', metadata: { reasons: ['x'] } })).message, 'Your input was flagged');
        });
    });

    describe('a 429, which means two different things', () => {
        // The words say "quota" for a limit that lifts in a minute and for one that lifts at
        // midnight, so the structure is read first. [name, provider, body, what it is].
        const rows: Array<[string, string, string, AiErrorKind]> = [
            ['Gemini, a per-day quota', 'gemini', geminiBody(429, 'RESOURCE_EXHAUSTED', GEMINI_QUOTA_WORDS, [quotaFailure(PER_DAY), retryInfo('1s')]), 'quota'],
            ['Gemini, a per-minute quota with the very same words', 'gemini', geminiBody(429, 'RESOURCE_EXHAUSTED', GEMINI_QUOTA_WORDS, [quotaFailure(PER_MINUTE), retryInfo('33s')]), 'rate'],
            ['Gemini, a per-day quota listed second', 'gemini', geminiBody(429, 'RESOURCE_EXHAUSTED', GEMINI_QUOTA_WORDS, [quotaFailure(PER_MINUTE, PER_DAY)]), 'quota'],
            ['Gemini, a per-month quota', 'gemini', geminiBody(429, 'RESOURCE_EXHAUSTED', GEMINI_QUOTA_WORDS, [quotaFailure('GenerateRequestsPerMonthPerProject')]), 'quota'],
            ['Gemini, no details at all, whatever the words say', 'gemini', geminiBody(429, 'RESOURCE_EXHAUSTED', GEMINI_QUOTA_WORDS), 'rate'],
            ['Gemini, details that are not a QuotaFailure', 'gemini', geminiBody(429, 'RESOURCE_EXHAUSTED', GEMINI_QUOTA_WORDS, [retryInfo('5s')]), 'rate'],
            ['Anthropic, a rate limit', 'anthropic', anthropicBody('rate_limit_error', "This request would exceed your organization's rate limit of 30,000 input tokens per minute."), 'rate'],
            ['Anthropic, a rate limit whose sentence says quota', 'anthropic', anthropicBody('rate_limit_error', 'You have exceeded your quota of requests.'), 'rate'],
            ['Anthropic, the monthly spend cap, a rate_limit_error too', 'anthropic', anthropicBody('rate_limit_error', 'You have reached your API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.', { error_code: 'enforced_spend_limit_reached' }), 'quota'],
            ['OpenAI, insufficient_quota', 'openai', openAiBody('insufficient_quota', 'You exceeded your current quota.'), 'quota'],
            ['OpenAI, a rate limit', 'openai', JSON.stringify({ error: { message: 'Rate limit reached for gpt-6 on tokens per min.', type: 'tokens', code: 'rate_limit_exceeded' } }), 'rate'],
            ['a custom endpoint that only has words for billing', 'custom', JSON.stringify({ error: 'Billing hard limit reached' }), 'quota'],
            ['a custom endpoint that only has words for a limit', 'custom', JSON.stringify({ error: 'Too many requests, slow down' }), 'rate'],
            // OpenAI's own words for an empty balance or a spend cap: the code decides, whatever `type` says.
            ['OpenAI, credit_balance_exhausted under a rate_limit_error type', 'openai', JSON.stringify({ error: { message: 'Your organization has no prepaid credits remaining.', type: 'rate_limit_error', code: 'credit_balance_exhausted' } }), 'quota'],
            ['OpenAI, organization_spend_limit_exceeded', 'openai', JSON.stringify({ error: { message: 'Request blocked.', type: 'billing_error', code: 'organization_spend_limit_exceeded' } }), 'quota'],
            ['OpenAI, project_spend_limit_exceeded', 'openai', JSON.stringify({ error: { message: 'Request blocked.', type: 'rate_limit_error', code: 'project_spend_limit_exceeded' } }), 'quota'],
            ['OpenAI, organization_usage_limit_exceeded', 'openai', JSON.stringify({ error: { message: 'Request blocked.', type: 'rate_limit_error', code: 'organization_usage_limit_exceeded' } }), 'quota'],
            ['OpenAI, slow_down, which is a rate_limit_error', 'openai', JSON.stringify({ error: { message: 'You are sending requests too quickly.', type: 'rate_limit_error', code: 'slow_down' } }), 'rate'],
            ['OpenAI, an empty balance said only in words, with the underscores', 'openai', JSON.stringify({ error: { message: 'Blocked.', type: 'x', code: 'credit_balance_exhausted_for_org' } }), 'quota'],
            ['a compatible endpoint that says the credits are gone', 'custom', JSON.stringify({ error: 'Your organization has no prepaid credits remaining.' }), 'quota'],
            ['OpenRouter, its 429 for a rate limit', 'openrouter', JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded', metadata: { error_type: 'rate_limit_exceeded' } } }), 'rate'],
            ['a 429 with nothing to read', 'openai', '', 'rate'],
            ['a 429 with an HTML body', 'custom', '<html>429</html>', 'rate'],
        ];
        for (const [name, provider, body, kind] of rows) {
            it(`${name} is ${kind}`, () => {
                const err = errorFromHttp(provider, 'm', 429, body);
                assert.equal(err.kind, kind);
                assert.equal(err.retryable, kind === 'rate');
            });
        }
    });

    describe('how long to wait', () => {
        it('reads retry-after, in seconds, off a rate limit', () => {
            const err = errorFromHttp('anthropic', 'm', 429, anthropicBody('rate_limit_error', 'slow down'), { retryAfter: '30' });
            assert.equal(err.kind, 'rate');
            assert.equal(err.retryAfterMs, 30_000);
        });

        it('reads retry-after off a 529 and a 503 too', () => {
            assert.equal(errorFromHttp('anthropic', 'm', 529, anthropicBody('overloaded_error', 'Overloaded'), { retryAfter: '2' }).retryAfterMs, 2000);
            assert.equal(errorFromHttp('gemini', 'm', 503, geminiBody(503, 'UNAVAILABLE', 'busy'), { retryAfter: '1.5' }).retryAfterMs, 1500);
        });

        it('takes Google\'s RetryInfo for a rate limit that has no header, as Google sends none', () => {
            const err = errorFromHttp('gemini', 'm', 429, geminiBody(429, 'RESOURCE_EXHAUSTED', GEMINI_QUOTA_WORDS, [quotaFailure(PER_MINUTE), retryInfo('33s')]));
            assert.equal(err.kind, 'rate');
            assert.equal(err.retryAfterMs, 33_000);
            // A header wins when there is one.
            assert.equal(errorFromHttp('gemini', 'm', 429, geminiBody(429, 'RESOURCE_EXHAUSTED', GEMINI_QUOTA_WORDS, [quotaFailure(PER_MINUTE), retryInfo('33s')]), { retryAfter: '5' }).retryAfterMs, 5000);
        });

        it('says nothing about waiting for an error that waiting cannot fix', () => {
            // A daily quota's RetryInfo is a few seconds that mean nothing; the spend cap sends no header.
            const daily = errorFromHttp('gemini', 'm', 429, geminiBody(429, 'RESOURCE_EXHAUSTED', GEMINI_QUOTA_WORDS, [quotaFailure(PER_DAY), retryInfo('1s')]), { retryAfter: '1' });
            assert.equal(daily.kind, 'quota');
            assert.equal(daily.retryAfterMs, undefined);
            assert.equal(errorFromHttp('anthropic', 'm', 401, anthropicBody('authentication_error', 'bad'), { retryAfter: '10' }).retryAfterMs, undefined);
            assert.equal(errorFromHttp('anthropic', 'm', 400, anthropicBody('invalid_request_error', 'bad'), { retryAfter: '10' }).retryAfterMs, undefined);
        });

        it('parses seconds, HTTP dates and nonsense, within a day', () => {
            const now = Date.parse('2026-10-13T12:00:00Z');
            assert.equal(parseRetryAfter('120', now), 120_000);
            assert.equal(parseRetryAfter('0', now), 0);
            assert.equal(parseRetryAfter(' 7 ', now), 7000);
            assert.equal(parseRetryAfter('Tue, 13 Oct 2026 12:01:00 GMT', now), 60_000);
            assert.equal(parseRetryAfter('Tue, 13 Oct 2026 11:00:00 GMT', now), 0);
            assert.equal(parseRetryAfter('99999999', now), 24 * 60 * 60 * 1000);
            // "-5" and "2026-10-13" are dates to Date.parse, and must not be read as ones.
            for (const junk of ['', '  ', 'soon', '-5', '1e9', '2026-10-13', undefined, null]) assert.equal(parseRetryAfter(junk as string | null | undefined, now), undefined, String(junk));
        });
    });

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
        const err = errorFromHttp('anthropic', 'm', 401, anthropicBody('authentication_error', `invalid x-api-key: ${KEY}`), { key: KEY });
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
        const err = new AiError({ kind: 'server', provider: 'gemini', model: 'm', status: 503, message: 'overloaded', retryAfterMs: 2000 });
        assert.deepEqual(JSON.parse(JSON.stringify(err)), {
            name: 'AiError', kind: 'server', provider: 'gemini', model: 'm', status: 503, retryable: true, retryAfterMs: 2000, message: 'overloaded',
        });
    });

    it('carries the tokens of an answer that was billed but unusable, in total and per model', () => {
        const billed = [{ model: 'claude-opus-5-5', in: 412, out: 0 }];
        const err = new AiError({ kind: 'refusal', provider: 'anthropic', model: 'm', message: 'declined', usage: { in: 412, out: 0 }, billed });
        assert.deepEqual(err.usage, { in: 412, out: 0 });
        assert.deepEqual(err.billed, billed);
        const json = JSON.parse(JSON.stringify(err));
        assert.deepEqual(json.usage, { in: 412, out: 0 });
        assert.deepEqual(json.billed, billed);
        const plain = new AiError({ kind: 'auth', provider: 'p', model: 'm', message: 'x' });
        assert.equal(plain.usage, undefined);
        assert.equal(plain.billed, undefined);
        assert.equal(plain.retryAfterMs, undefined);
    });

    it('has `code` equal to its kind: the one field of an Error the logger keeps', () => {
        for (const kind of AI_ERROR_KINDS) assert.equal(new AiError({ kind, provider: 'p', model: 'm', message: 'x' }).code, kind);
        const described = describeError(new AiError({ kind: 'quota', provider: 'gemini', model: 'm', status: 429, message: 'spent' }));
        assert.equal(described['code'], 'quota');
        assert.equal(described['message'], 'spent');
    });
});

describe('aiErrorLogFields', () => {
    const err = new AiError({
        kind: 'rate', provider: 'gemini', model: 'gemini-3.8-flash', status: 429, message: 'slow down', retryAfterMs: 33_000, usage: { in: 90, out: 20 },
    });

    it('names everything worth searching a log for, with names the logger does not redact', () => {
        const fields = aiErrorLogFields(err);
        assert.equal(fields['kind'], 'rate');
        assert.equal(fields['provider'], 'gemini');
        assert.equal(fields['model'], 'gemini-3.8-flash');
        assert.equal(fields['status'], 429);
        assert.equal(fields['retryable'], true);
        assert.equal(fields['retry_after_ms'], 33_000);
        assert.equal(fields['in'], 90);
        assert.equal(fields['out'], 20);
        // The logger redacts a field by the words in its name; none of these has one.
        for (const name of Object.keys(fields)) assert.doesNotMatch(name, /token|secret|password|passwd|api[-_]?key|authorization|signature|cookie/i, name);
    });

    it('leaves out what an error does not have', () => {
        const bare = aiErrorLogFields(new AiError({ kind: 'auth', provider: 'anthropic', model: 'm', message: 'x' }));
        assert.equal(bare['status'], undefined);
        assert.equal(bare['in'], undefined);
        assert.equal(bare['retry_after_ms'], undefined);
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
            openrouter: 'sk-or-v1-' + '0123'.repeat(8),
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
