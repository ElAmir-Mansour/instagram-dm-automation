/**
 * The check a new Gemini key must pass before it replaces the platform's.
 *
 * Saving swaps the key in for every tenant at once, so each way Google can answer has to land
 * on the right side: refused keys are never saved, a Google outage is a retry rather than a
 * verdict, and a spent quota is a working key with a warning.
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { checkGeminiKey } from './geminiKey.js';

const KEY = 'AIza.fake.key-under-test.example';

type Call = { method: 'get' | 'post'; url: string; key: unknown };
let calls: Call[];
let originalGet: typeof axios.get;
let originalPost: typeof axios.post;

/** An axios-shaped rejection with Google's error body. */
function googleSays(status: number, message: string): Error {
    return Object.assign(new Error(`Request failed with status code ${status}`), {
        response: { status, data: { error: { code: status, message } } },
    });
}

/** Route the list call and each model's generateContent to an answer. */
function google(list: () => unknown, models: Record<string, () => unknown> = {}): void {
    (axios as any).get = async (url: string, config: any) => {
        calls.push({ method: 'get', url, key: config?.headers?.['x-goog-api-key'] });
        return list();
    };
    (axios as any).post = async (url: string, _body: unknown, config: any) => {
        calls.push({ method: 'post', url, key: config?.headers?.['x-goog-api-key'] });
        const model = url.match(/models\/([^:]+):generateContent$/)?.[1] ?? '';
        const answer = models[model];
        if (!answer) throw new Error(`no answer arranged for ${model}`);
        return answer();
    };
}

const ok = () => ({ status: 200, data: {} });
const fail = (err: Error) => () => { throw err; };

beforeEach(() => {
    calls = [];
    originalGet = axios.get;
    originalPost = axios.post;
});

afterEach(() => {
    (axios as any).get = originalGet;
    (axios as any).post = originalPost;
});

describe('checkGeminiKey', () => {
    it('passes a key Google accepts and that runs every model', async () => {
        google(ok, { 'gemini-2.5-flash': ok, 'gemini-3.8-flash': ok });

        assert.deepEqual(await checkGeminiKey(KEY, ['gemini-2.5-flash', 'gemini-3.8-flash']), { ok: true, quotaSpent: [] });
        assert.deepEqual(calls.map((c) => c.method), ['get', 'post', 'post']);
    });

    it('sends the key in a header only, never in a URL', async () => {
        // A URL ends up in logs and error reports; an axios error carries it as config.url.
        google(ok, { 'gemini-2.5-flash': ok });
        await checkGeminiKey(KEY, ['gemini-2.5-flash']);

        for (const call of calls) {
            assert.equal(call.key, KEY);
            assert.ok(!call.url.includes(KEY), call.url);
        }
    });

    it('refuses a key Google says is not valid, without trying any model', async () => {
        google(fail(googleSays(400, 'API key not valid. Please pass a valid API key.')));

        const result = await checkGeminiKey(KEY, ['gemini-2.5-flash']);
        assert.deepEqual(result, { ok: false, status: 400, error: 'Google refused this key: API key not valid. Please pass a valid API key.' });
        assert.equal(calls.length, 1);
    });

    it('refuses a key whose project has the API switched off', async () => {
        google(fail(googleSays(403, 'Generative Language API has not been used in project 123 before or it is disabled.')));

        const result = await checkGeminiKey(KEY, ['gemini-2.5-flash']);
        assert.equal(result.ok, false);
        assert.equal(!result.ok && result.status, 400);
    });

    it('refuses a valid key that cannot run the DM bot\'s model, and names the model', async () => {
        // The case this check exists for: Google serves the 2.5 models only to projects that
        // used them before, so a key from a new project lists fine and fails every DM.
        google(ok, { 'gemini-2.5-flash': fail(googleSays(404, 'models/gemini-2.5-flash is not found for API version v1beta.')) });

        const result = await checkGeminiKey(KEY, ['gemini-2.5-flash']);
        assert.equal(result.ok, false);
        assert.equal(!result.ok && result.status, 400);
        assert.match(!result.ok ? result.error : '', /cannot run gemini-2\.5-flash, which the DM bot uses: models\/gemini-2\.5-flash is not found/);
    });

    it('stops at the first model it cannot run', async () => {
        google(ok, { 'gemini-2.5-flash': fail(googleSays(403, 'denied')), 'gemini-3.8-flash': ok });

        await checkGeminiKey(KEY, ['gemini-2.5-flash', 'gemini-3.8-flash']);
        assert.equal(calls.filter((c) => c.method === 'post').length, 1);
    });

    it('passes a key whose quota is spent for today, and says on which models', async () => {
        google(ok, {
            'gemini-2.5-flash': fail(googleSays(429, 'You exceeded your current quota.')),
            'gemini-3.8-flash': ok,
        });

        assert.deepEqual(await checkGeminiKey(KEY, ['gemini-2.5-flash', 'gemini-3.8-flash']),
            { ok: true, quotaSpent: ['gemini-2.5-flash'] });
    });

    it('treats Google being down, or unreachable, as a retry and not a verdict', async () => {
        for (const err of [googleSays(503, 'The model is overloaded.'), googleSays(500, 'Internal error'),
            Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ECONNABORTED' })]) {
            google(fail(err));
            const onList = await checkGeminiKey(KEY, ['gemini-2.5-flash']);
            assert.equal(!onList.ok && onList.status, 502, err.message);
            assert.match(!onList.ok ? onList.error : '', /Nothing was saved; try again/);

            google(ok, { 'gemini-2.5-flash': fail(err) });
            const onModel = await checkGeminiKey(KEY, ['gemini-2.5-flash']);
            assert.equal(!onModel.ok && onModel.status, 502, err.message);
        }
    });

    it('treats a 429 on the free list call as a retry, not a refusal', async () => {
        google(fail(googleSays(429, 'Too many requests')));
        const result = await checkGeminiKey(KEY, ['gemini-2.5-flash']);
        assert.equal(!result.ok && result.status, 502);
    });
});
