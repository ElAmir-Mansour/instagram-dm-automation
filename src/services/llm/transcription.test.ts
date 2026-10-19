/**
 * The speech-to-text call: what goes on the wire to an OpenAI-compatible `/audio/transcriptions`, and every way it can come back
 * (docs/specs/001-whatsapp-agent T034). No network: a `fetch` stand-in records each request, FormData and all.
 *
 * `testFetch.ts`'s `stubFetch` is not used for the request itself because it parses the body as JSON, and this body is multipart; its
 * `jsonResponse` and `hangingFetch` are.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AiError } from './errors.js';
import { transcribeWithProvider, transcriptionUrl, TRANSCRIPTION_TIMEOUT_MS, type TranscriptionArgs } from './transcription.js';
import { hangingFetch, jsonResponse } from './testFetch.js';
import type { FetchLike } from './types.js';
import { FAKE_KEYS } from '../aiProviders/testKeys.js';

const KEY = FAKE_KEYS.groq;
const AUDIO = Buffer.from([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4, 5]); // "OggS" + bytes

interface Seen { url: string; method: string | undefined; headers: Record<string, string>; form: FormData; redirect: RequestInit['redirect']; signal: AbortSignal | null | undefined }

function recorder(...answers: Array<Response | Error>): { fetchImpl: FetchLike; seen: Seen[] } {
    const seen: Seen[] = [];
    const queue = [...answers];
    const fetchImpl: FetchLike = async (url, init) => {
        seen.push({
            url, method: init.method, redirect: init.redirect, signal: init.signal,
            headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
            form: init.body as FormData,
        });
        const next = queue.shift();
        if (!next) throw new Error('unexpected extra fetch');
        if (next instanceof Error) throw next;
        return next;
    };
    return { fetchImpl, seen };
}

const base = (over: Partial<TranscriptionArgs> = {}): TranscriptionArgs => ({
    provider: 'groq', apiKey: KEY, model: 'whisper-large-v3-turbo', audio: AUDIO, mimeType: 'audio/ogg', filename: 'voice.ogg', language: 'ar', ...over,
});

const failureOf = (promise: Promise<unknown>): Promise<AiError> =>
    promise.then(() => { throw new Error('expected a failure'); }, (err) => { assert.ok(err instanceof AiError, String(err)); return err as AiError; });

describe('transcribeWithProvider: the request', () => {
    it('POSTs multipart to Groq\'s /audio/transcriptions with the model, language, json format and the audio, and the key only in a header', async () => {
        const { fetchImpl, seen } = recorder(jsonResponse(200, { text: 'مرحبا بكم', x_groq: { id: 'req_1' } }));

        const out = await transcribeWithProvider(base({ fetchImpl }));

        assert.deepEqual(out, { text: 'مرحبا بكم', model: 'whisper-large-v3-turbo' });
        assert.equal(seen.length, 1);
        const call = seen[0]!;
        assert.equal(call.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
        assert.equal(call.method, 'POST');
        assert.equal(call.headers.authorization, `Bearer ${KEY}`);
        assert.equal(call.headers['content-type'], undefined, 'fetch sets multipart/form-data with its boundary; setting one here would break it');
        assert.equal(call.redirect, 'error', 'a redirect must never carry the key to another address');
        assert.ok(call.signal, 'every call has a deadline');

        assert.ok(call.form instanceof FormData);
        assert.equal(call.form.get('model'), 'whisper-large-v3-turbo');
        assert.equal(call.form.get('language'), 'ar');
        assert.equal(call.form.get('response_format'), 'json');
        assert.equal(call.form.get('temperature'), '0');
        const file = call.form.get('file') as File;
        assert.ok(file instanceof Blob, 'the audio is the `file` part');
        assert.equal(file.name, 'voice.ogg', 'Groq reads the format from the file name');
        assert.equal(file.type, 'audio/ogg');
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), AUDIO);
        assert.deepEqual([...call.form.keys()].sort(), ['file', 'language', 'model', 'response_format', 'temperature']);

        const everything = call.url + JSON.stringify([...call.form.entries()].filter(([k]) => k !== 'file'));
        assert.ok(!everything.includes(KEY), 'the key is in the header and nowhere else');
    });

    it('sends no language when none is given, and reads a duration (seconds) when the answer carries one', async () => {
        const { fetchImpl, seen } = recorder(jsonResponse(200, { text: '  hello \n', duration: 3.2 }));
        const out = await transcribeWithProvider(base({ fetchImpl, language: undefined }));
        assert.equal(seen[0]!.form.has('language'), false);
        assert.deepEqual(out, { text: 'hello', model: 'whisper-large-v3-turbo', durationMs: 3200 });
    });

    it('speaks to OpenAI at its own base URL, same shape', async () => {
        assert.equal(transcriptionUrl('openai'), 'https://api.openai.com/v1/audio/transcriptions');
        const { fetchImpl, seen } = recorder(jsonResponse(200, { text: 'x' }));
        await transcribeWithProvider(base({ provider: 'openai', apiKey: FAKE_KEYS.openai, model: 'whisper-1', fetchImpl }));
        assert.equal(seen[0]!.url, 'https://api.openai.com/v1/audio/transcriptions');
        assert.equal(seen[0]!.headers.authorization, `Bearer ${FAKE_KEYS.openai}`);
    });

    it('has no endpoint for a provider with no base URL (Custom: the operator\'s address is not a place to send a customer\'s voice)', async () => {
        const err = await failureOf(transcribeWithProvider(base({ provider: 'custom', fetchImpl: recorder().fetchImpl })));
        assert.equal(err.kind, 'bad_request');
    });

    it('has a 20 s deadline by default, and a stand-in server that never answers ends as a timeout', async () => {
        assert.equal(TRANSCRIPTION_TIMEOUT_MS, 20_000);
        const err = await failureOf(transcribeWithProvider(base({ fetchImpl: hangingFetch, timeoutMs: 30 })));
        assert.equal(err.kind, 'timeout');
        assert.equal(err.retryable, true);
    });

    it('honours the caller\'s own abort as well', async () => {
        const controller = new AbortController();
        const pending = failureOf(transcribeWithProvider(base({ fetchImpl: hangingFetch, signal: controller.signal })));
        controller.abort();
        assert.equal((await pending).kind, 'timeout');
    });
});

describe('transcribeWithProvider: every way it comes back', () => {
    it('401 is auth, 429 is a rate limit that says how long to wait, 5xx is the provider\'s fault', async () => {
        const auth = await failureOf(transcribeWithProvider(base({ fetchImpl: recorder(jsonResponse(401, { error: { message: 'Invalid API Key', type: 'invalid_request_error' } })).fetchImpl })));
        assert.equal(auth.kind, 'auth');
        assert.equal(auth.status, 401);

        const rate = await failureOf(transcribeWithProvider(base({ fetchImpl: recorder(jsonResponse(429, { error: { message: 'Rate limit reached for model whisper-large-v3-turbo', type: 'tokens' } }, { 'retry-after': '7' })).fetchImpl })));
        assert.equal(rate.kind, 'rate');
        assert.equal(rate.retryAfterMs, 7000);

        const server = await failureOf(transcribeWithProvider(base({ fetchImpl: recorder(jsonResponse(503, { error: { message: 'unavailable' } })).fetchImpl })));
        assert.equal(server.kind, 'server');
    });

    it('a 200 that is not JSON, or has no text, is bad_output; a network failure is a timeout', async () => {
        const html = await failureOf(transcribeWithProvider(base({ fetchImpl: recorder(new Response('<html>gateway</html>', { status: 200 })).fetchImpl })));
        assert.equal(html.kind, 'bad_output');
        const none = await failureOf(transcribeWithProvider(base({ fetchImpl: recorder(jsonResponse(200, { result: 'x' })).fetchImpl })));
        assert.equal(none.kind, 'bad_output');
        const down = await failureOf(transcribeWithProvider(base({ fetchImpl: recorder(new TypeError('fetch failed')).fetchImpl })));
        assert.equal(down.kind, 'timeout');
    });

    it('refuses a redirect, whether fetch throws on it or a stand-in returns it', async () => {
        const thrown = await failureOf(transcribeWithProvider(base({ fetchImpl: recorder(Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') })).fetchImpl })));
        assert.equal(thrown.kind, 'bad_request');
        const returned = await failureOf(transcribeWithProvider(base({ fetchImpl: recorder(new Response(null, { status: 307, headers: { location: 'https://evil.example/' } })).fetchImpl })));
        assert.equal(returned.kind, 'bad_request');
        assert.match(returned.message, /redirect/i);
    });

    it('never lets the key out in an error, even when the provider echoes it back', async () => {
        const err = await failureOf(transcribeWithProvider(base({ fetchImpl: recorder(jsonResponse(401, { error: { message: `Incorrect API key provided: ${KEY}` } })).fetchImpl })));
        assert.ok(!err.message.includes(KEY));
        assert.ok(!JSON.stringify(err).includes(KEY));
    });
});
