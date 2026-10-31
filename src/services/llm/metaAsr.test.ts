/**
 * Meta's speech-to-text client (`metaAsr.ts`): what goes on the wire (the multipart body, byte for byte the shape tried live on 2026-10-28), what an hour of audio costs,
 * and every way the call can come back. No network: `fetchImpl` is a stand-in that records each request, binary body and all. The key, the budget and the `ai_usage` row
 * belong to `aiProviders/asr.ts` and are tested there.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { AiError } from './errors.js';
import {
    ASR_LANGUAGE_BIAS, ASR_MAX_KEYWORDS, ASR_MODEL, ASR_PROVIDER, ASR_TIMEOUT_MS, ASR_USD_PER_HOUR, asrUrl, asrUsd, buildAsrRequest, buildMultipart, callMetaAsr, type AsrArgs,
} from './metaAsr.js';
import { parseMultipart, wavBytes } from './testAudio.js';
import { hangingFetch, jsonResponse } from './testFetch.js';
import type { FetchLike } from './types.js';
import { FAKE_KEYS } from '../aiProviders/testKeys.js';

const KEY = FAKE_KEYS.meta;
const WAV = wavBytes({ seconds: 1, info: true, tone: true });

interface Seen { url: string; method: string | undefined; headers: Record<string, string>; body: Buffer; redirect: RequestInit['redirect']; signal: AbortSignal | null | undefined }

/** Answers each call with the next item and keeps what was sent, the body as the bytes it is. */
function recorder(...answers: Array<Response | Error>): { fetchImpl: FetchLike; seen: Seen[] } {
    const seen: Seen[] = [];
    const queue = [...answers];
    const fetchImpl: FetchLike = async (url, init) => {
        const body = init.body as Uint8Array;
        seen.push({
            url, method: init.method, redirect: init.redirect, signal: init.signal,
            headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
            body: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
        });
        const next = queue.shift();
        if (!next) throw new Error('unexpected extra fetch');
        if (next instanceof Error) throw next;
        return next;
    };
    return { fetchImpl, seen };
}

const ok = (over: Record<string, unknown> = {}): Response => jsonResponse(200, { sessionId: 'sess-1', transcript: 'بكام الاشتراك', audioDurationMs: 1022, turns: [], ...over });

const call = (fetchImpl: FetchLike, over: Partial<AsrArgs> = {}) => callMetaAsr({ apiKey: KEY, wav: WAV, fetchImpl, ...over });

const failureOf = (promise: Promise<unknown>): Promise<AiError> =>
    promise.then(() => { throw new Error('expected a failure'); }, (err) => { assert.ok(err instanceof AiError, String(err)); return err as AiError; });

describe('what an hour of audio costs', () => {
    it('is $0.18 an hour for Muse Voice Transcribe, by the millisecond', () => {
        assert.equal(ASR_MODEL, 'muse-voice-transcribe-1.0');
        assert.equal(ASR_PROVIDER, 'meta');
        assert.equal(ASR_USD_PER_HOUR, 0.18);
        assert.equal(asrUsd(3_600_000), 0.18);
        assert.equal(asrUsd(1_800_000), 0.09);
        assert.equal(asrUsd(60_000), 0.003);
        assert.equal(asrUsd(1_000), 0.00005);
        // The longest note answered: three minutes.
        assert.equal(asrUsd(180_000), 0.009);
        assert.equal(asrUsd(1_022), 0.0000511);
    });

    it('is audioDurationMs / 3,600,000 x 0.18, to the billionth: no floating-point noise in the sums ai_usage adds up', () => {
        for (const ms of [1, 7, 999, 2_500, 17_321, 59_999, 123_456, 600_000, 3_599_999]) {
            const expected = Math.round((ms / 3_600_000) * 0.18 * 1e9) / 1e9;
            assert.equal(asrUsd(ms), expected, String(ms));
            assert.ok(Math.abs(asrUsd(ms) - (ms / 3_600_000) * 0.18) < 1e-9, String(ms));
        }
        assert.equal(String(asrUsd(3_000)), '0.00015');
        assert.equal(String(asrUsd(7)), '3.5e-7');
    });

    it('is nothing for no audio, a negative length, or a number that is not one', () => {
        for (const ms of [0, -1, -3_600_000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) assert.equal(asrUsd(ms), 0, String(ms));
    });
});

describe('the request part', () => {
    it('is exactly the contract\'s, in its key order: model, audioEncoding WAV, languageBias Arabic and English, then the keywords', () => {
        assert.equal(
            JSON.stringify(buildAsrRequest(['Data Academy', 'اشتراك بايثون'])),
            '{"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV","languageBias":["Arabic","English"],"keywords":["Data Academy","اشتراك بايثون"]}',
        );
        assert.deepEqual([...ASR_LANGUAGE_BIAS], ['Arabic', 'English']);
    });

    it('leaves `keywords` out when there are none (it is optional), rather than sending an empty list nobody has tried', () => {
        for (const none of [undefined, [], ['', '   ']]) {
            assert.equal(JSON.stringify(buildAsrRequest(none)), '{"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV","languageBias":["Arabic","English"]}');
        }
    });

    it('trims the terms, drops blank ones and anything that is not text, and sends at most twenty', () => {
        assert.deepEqual(buildAsrRequest(['  one  ', '', 'two', 3 as unknown as string, null as unknown as string]).keywords, ['one', 'two']);
        const many = Array.from({ length: 30 }, (_, i) => `term ${i}`);
        assert.equal(ASR_MAX_KEYWORDS, 20);
        assert.deepEqual(buildAsrRequest(many).keywords, many.slice(0, 20));
    });

    it('is a fresh object each time, so one call cannot change the next', () => {
        const a = buildAsrRequest(['x']);
        a.languageBias.push('French');
        assert.deepEqual(buildAsrRequest(['x']).languageBias, ['Arabic', 'English']);
    });
});

describe('the multipart body: the shape that was tried live (scripts/meta-probe.mjs, 2026-10-28)', () => {
    it('is byte for byte what the probe\'s own multipart() writes for the same parts and boundary', async () => {
        const probe = await import(new URL('../../../scripts/meta-probe.mjs', import.meta.url).href) as {
            multipart: (parts: unknown[], boundary: string) => { contentType: string; body: Buffer };
            requests: { asr: () => unknown };
        };
        const parts = [
            { name: 'request', type: 'application/json', data: JSON.stringify(buildAsrRequest(['probe'])) },
            { name: 'audio', filename: 'probe.wav', type: 'audio/wav', data: WAV },
        ];
        const ours = buildMultipart(parts, 'testboundary123');
        const theirs = probe.multipart(parts, 'testboundary123');
        assert.equal(ours.contentType, theirs.contentType);
        assert.ok(ours.body.equals(theirs.body), 'the same bytes');
        // And the request part itself is what the probe sent, key order and all.
        assert.equal(JSON.stringify(buildAsrRequest(['probe'])), JSON.stringify(probe.requests.asr()));
    });

    it('writes each part as a boundary line, a Content-Disposition (a filename only for a file), a Content-Type, a blank line, the data and a line break, then the closing boundary', () => {
        const { body, contentType, boundary } = buildMultipart([
            { name: 'request', type: 'application/json', data: '{"a":1}' },
            { name: 'audio', filename: 'voice.wav', type: 'audio/wav', data: Buffer.from([1, 2, 3]) },
        ], 'B');
        assert.equal(boundary, 'B');
        assert.equal(contentType, 'multipart/form-data; boundary=B');
        assert.equal(
            body.toString('latin1'),
            '--B\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n{"a":1}\r\n'
            + '--B\r\nContent-Disposition: form-data; name="audio"; filename="voice.wav"\r\nContent-Type: audio/wav\r\n\r\n\u0001\u0002\u0003\r\n'
            + '--B--\r\n',
        );
    });

    it('has a boundary of its own each time, and the parts survive a round trip: the audio is the same bytes, a JSON part has no filename', () => {
        const a = buildMultipart([{ name: 'audio', type: 'audio/wav', data: WAV }]);
        const b = buildMultipart([{ name: 'audio', type: 'audio/wav', data: WAV }]);
        assert.notEqual(a.boundary, b.boundary);
        assert.match(a.boundary, /^autoreply[0-9a-f]{24}$/);
        const [part] = parseMultipart(a.body, a.contentType);
        assert.ok(part!.data.equals(WAV));
        assert.equal(part!.filename, undefined);
    });

    it('copies a sub-view of a larger buffer for what it is, not the whole slab behind it', () => {
        const slab = Buffer.alloc(100, 7);
        const view = slab.subarray(10, 14);
        const { body, contentType } = buildMultipart([{ name: 'audio', type: 'audio/wav', data: view }]);
        const [part] = parseMultipart(body, contentType);
        assert.deepEqual([...part!.data], [7, 7, 7, 7]);
    });
});

describe('the call', () => {
    it('POSTs multipart to Meta\'s /v1/asr/transcribe: the key as a Bearer header only, the request part as JSON with no filename, the audio as the WAV', async () => {
        const { fetchImpl, seen } = recorder(ok());
        const out = await call(fetchImpl, { keywords: ['Data Academy', 'AutoReply'], boundary: 'fixedboundary' });

        assert.equal(seen.length, 1);
        const sent = seen[0]!;
        assert.equal(asrUrl(), 'https://api.meta.ai/v1/asr/transcribe');
        assert.equal(sent.url, 'https://api.meta.ai/v1/asr/transcribe');
        assert.equal(sent.method, 'POST');
        assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
        assert.equal(sent.headers.accept, 'application/json');
        assert.equal(sent.headers['content-type'], 'multipart/form-data; boundary=fixedboundary');
        assert.equal(sent.redirect, 'error', 'a redirect must never carry the key to another address');
        assert.ok(sent.signal, 'every call has a deadline');

        const parts = parseMultipart(sent.body, sent.headers['content-type']!);
        assert.deepEqual(parts.map((p) => p.name), ['request', 'audio']);
        const [request, audio] = parts as [typeof parts[number], typeof parts[number]];
        assert.equal(request.type, 'application/json');
        assert.equal(request.filename, undefined, 'the JSON part is a field, not a file');
        assert.deepEqual(JSON.parse(request.data.toString('utf8')), {
            model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', languageBias: ['Arabic', 'English'], keywords: ['Data Academy', 'AutoReply'],
        });
        assert.equal(audio.type, 'audio/wav');
        assert.equal(audio.filename, 'voice.wav');
        assert.ok(audio.data.equals(WAV), 'the audio is exactly the WAV that was handed in');

        assert.ok(!sent.url.includes(KEY) && !sent.body.includes(KEY), 'the key is in the header and nowhere else');
        assert.deepEqual(out, { transcript: 'بكام الاشتراك', durationMs: 1022, model: 'muse-voice-transcribe-1.0', sessionId: 'sess-1' });
    });

    it('sends no keywords key when there are none, and at most twenty when there are more', async () => {
        const none = recorder(ok());
        await call(none.fetchImpl);
        assert.ok(!('keywords' in JSON.parse(parseMultipart(none.seen[0]!.body, none.seen[0]!.headers['content-type']!)[0]!.data.toString('utf8'))));

        const many = recorder(ok());
        await call(many.fetchImpl, { keywords: Array.from({ length: 25 }, (_, i) => `name ${i}`) });
        const request = JSON.parse(parseMultipart(many.seen[0]!.body, many.seen[0]!.headers['content-type']!)[0]!.data.toString('utf8'));
        assert.equal(request.keywords.length, 20);
    });

    it('trims the key it is given', async () => {
        const { fetchImpl, seen } = recorder(ok());
        await call(fetchImpl, { apiKey: `  ${KEY}\n` });
        assert.equal(seen[0]!.headers.authorization, `Bearer ${KEY}`);
    });

    it('has a 30 s deadline by default, and a server that never answers ends as a timeout, which may be tried once more', async () => {
        assert.equal(ASR_TIMEOUT_MS, 30_000);
        const err = await failureOf(call(hangingFetch, { timeoutMs: 30 }));
        assert.equal(err.kind, 'timeout');
        assert.equal(err.retryable, true);
        assert.equal(err.provider, 'meta');
        assert.equal(err.model, ASR_MODEL);
    });

    it('honours the caller\'s own abort as well', async () => {
        const controller = new AbortController();
        const pending = failureOf(call(hangingFetch, { signal: controller.signal }));
        controller.abort();
        assert.equal((await pending).kind, 'timeout');
    });

    it('is `no_provider` with no key, and sends nothing', async () => {
        const { fetchImpl, seen } = recorder(ok());
        for (const apiKey of ['', '   ', undefined as unknown as string]) {
            const err = await failureOf(call(fetchImpl, { apiKey }));
            assert.equal(err.kind, 'no_provider');
        }
        assert.equal(seen.length, 0);
    });

    it('refuses a file the endpoint will not take BEFORE any request: not a WAV, stereo, 44.1 kHz, 8-bit', async () => {
        const { fetchImpl, seen } = recorder(ok());
        const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(64)]);
        for (const wav of [mp4, Buffer.alloc(0), wavBytes({ channels: 2 }), wavBytes({ rate: 44_100 }), wavBytes({ bits: 8 }), wavBytes({ format: 3 })]) {
            const err = await failureOf(call(fetchImpl, { wav }));
            assert.equal(err.kind, 'bad_request');
            assert.equal(err.retryable, false);
        }
        assert.equal(seen.length, 0, 'nothing was sent for any of them');
    });

    it('takes a 16 kHz WAV as well as a 24 kHz one', async () => {
        const { fetchImpl, seen } = recorder(ok());
        await call(fetchImpl, { wav: wavBytes({ rate: 16_000 }) });
        assert.equal(seen.length, 1);
    });
});

describe('the answer', () => {
    it('is the transcript (trimmed), what Meta says it processed, and the session id for a support ticket', async () => {
        const out = await call(recorder(ok({ transcript: '  عايز أعرف بكام الاشتراك؟ \n', audioDurationMs: 4321, sessionId: 'abc-123_X.y:z' })).fetchImpl);
        assert.deepEqual(out, { transcript: 'عايز أعرف بكام الاشتراك؟', durationMs: 4321, model: 'muse-voice-transcribe-1.0', sessionId: 'abc-123_X.y:z' });
    });

    it('rounds a duration that is not whole, and falls back to the WAV\'s own length when the answer does not say (or says nonsense)', async () => {
        assert.equal((await call(recorder(ok({ audioDurationMs: 2500.4 })).fetchImpl)).durationMs, 2500);
        const own = wavBytes({ seconds: 2 });
        for (const audioDurationMs of [undefined, null, 'long', -5, Number.NaN]) {
            const out = await call(recorder(ok({ audioDurationMs })).fetchImpl, { wav: own });
            assert.equal(out.durationMs, 2000, String(audioDurationMs));
        }
    });

    it('an empty transcript is an answer, not an error: silence is for the caller to decide about', async () => {
        const out = await call(recorder(ok({ transcript: '' })).fetchImpl);
        assert.equal(out.transcript, '');
        assert.equal(out.durationMs, 1022);
    });

    it('keeps a session id only when it looks like one, so nothing odd reaches a log line', async () => {
        for (const sessionId of ['<script>alert(1)</script>', 'a'.repeat(101), '', 'two words', 42, null]) {
            const out = await call(recorder(ok({ sessionId })).fetchImpl);
            assert.equal('sessionId' in out, false, String(sessionId));
        }
    });
});

describe('every way it can fail is an AiError of the providers layer\'s kinds', () => {
    const answer = async (response: Response): Promise<AiError> => failureOf(call(recorder(response).fetchImpl));

    it('401 and 403 are auth (a key that may not do this: final), and the provider is Meta and the model the speech one', async () => {
        for (const status of [401, 403]) {
            const err = await answer(jsonResponse(status, { error: { message: 'Invalid API key', type: 'authentication_error' } }));
            assert.equal(err.kind, 'auth', String(status));
            assert.equal(err.status, status);
            assert.equal(err.retryable, false);
            assert.equal(err.provider, 'meta');
            assert.equal(err.model, ASR_MODEL);
        }
    });

    it('429 is a rate limit that says how long to wait (the concurrency or hourly limit), 5xx is the provider\'s fault, 408 is a timeout', async () => {
        const rate = await answer(jsonResponse(429, { error: { message: 'Concurrency limit reached' } }, { 'retry-after': '7' }));
        assert.equal(rate.kind, 'rate');
        assert.equal(rate.retryAfterMs, 7000);
        for (const status of [500, 502, 503]) assert.equal((await answer(jsonResponse(status, { error: { message: 'Transcription failed' } }))).kind, 'server', String(status));
        assert.equal((await answer(jsonResponse(408, { error: { message: 'slow' } }))).kind, 'timeout');
    });

    it('400 (not a supported WAV, more than 10 minutes), 406 and 413 (over 32 MB) are bad_request: the request\'s own fault, never retried', async () => {
        for (const status of [400, 406, 413]) {
            const err = await answer(jsonResponse(status, { error: { message: 'Audio is not a supported WAV file', type: 'invalid_request_error', code: 'invalid_audio' } }));
            assert.equal(err.kind, 'bad_request', String(status));
            assert.equal(err.retryable, false);
        }
    });

    it('a 200 that is not JSON (a gateway\'s page), or has no transcript, is bad_output; a network failure is a timeout', async () => {
        assert.equal((await answer(new Response('<html>gateway</html>', { status: 200 }))).kind, 'bad_output');
        assert.equal((await answer(jsonResponse(200, { result: 'x' }))).kind, 'bad_output');
        assert.equal((await answer(jsonResponse(200, { transcript: 7 }))).kind, 'bad_output');
        assert.equal((await answer(jsonResponse(200, 'null'))).kind, 'bad_output');
        const down = await failureOf(call(recorder(new TypeError('fetch failed')).fetchImpl));
        assert.equal(down.kind, 'timeout');
    });

    it('refuses a redirect, whether fetch throws on it or a stand-in returns it, so the key is never sent to another address', async () => {
        const thrown = await failureOf(call(recorder(Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') })).fetchImpl));
        assert.equal(thrown.kind, 'bad_request');
        assert.match(thrown.message, /redirect/i);
        const returned = await answer(new Response(null, { status: 307, headers: { location: 'https://evil.example/' } }));
        assert.equal(returned.kind, 'bad_request');
        assert.match(returned.message, /redirect/i);
    });

    it('never lets the key out in an error, even when the provider echoes it back, and never carries the audio', async () => {
        const err = await answer(jsonResponse(401, { error: { message: `Incorrect API key provided: ${KEY}` } }));
        assert.ok(!err.message.includes(KEY));
        assert.ok(!JSON.stringify(err).includes(KEY));
        assert.ok(!String(err.stack).includes(KEY));
        const echoed = await answer(jsonResponse(400, { error: { message: `bad audio ${Buffer.from(WAV).toString('base64').slice(0, 60)}` } }));
        assert.ok(echoed.message.length <= 240, 'an error message is cut, whatever it quotes');
    });
});

describe('over a real socket (a local server standing in for Meta): what the real fetch does with the body, the headers, a redirect and a deadline', () => {
    let server: Server;
    let origin: string;
    let received: { headers: IncomingMessage['headers']; method: string | undefined; url: string | undefined; body: Buffer }[];
    let behave: (req: IncomingMessage, res: import('node:http').ServerResponse) => void;

    before(async () => {
        server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => {
                received.push({ headers: req.headers, method: req.method, url: req.url, body: Buffer.concat(chunks) });
                behave(req, res);
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    /** The real `fetch`, with Meta's address swapped for the local server's. Nothing else about the request is touched. */
    const local: FetchLike = (url, init) => fetch(url.replace('https://api.meta.ai', origin), init);

    it('sends a body the server can read: the multipart with its boundary intact, the right length, the key as a Bearer header, and the WAV byte for byte', async () => {
        received = [];
        behave = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ sessionId: 's-1', transcript: 'بكام الاشتراك', audioDurationMs: 1022, turns: [] })); };
        const out = await callMetaAsr({ apiKey: KEY, wav: WAV, keywords: ['Data Academy'], fetchImpl: local });

        assert.deepEqual(out, { transcript: 'بكام الاشتراك', durationMs: 1022, model: ASR_MODEL, sessionId: 's-1' });
        assert.equal(received.length, 1);
        const got = received[0]!;
        assert.equal(got.method, 'POST');
        assert.equal(got.url, '/v1/asr/transcribe');
        assert.equal(got.headers.authorization, `Bearer ${KEY}`);
        assert.equal(got.headers.accept, 'application/json');
        assert.match(String(got.headers['content-type']), /^multipart\/form-data; boundary=autoreply[0-9a-f]{24}$/);
        assert.equal(Number(got.headers['content-length']), got.body.length, 'the length the server was told is the length it got');
        const [request, audio] = parseMultipart(got.body, String(got.headers['content-type']));
        assert.deepEqual(JSON.parse(request!.data.toString('utf8')), {
            model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', languageBias: ['Arabic', 'English'], keywords: ['Data Academy'],
        });
        assert.equal(request!.filename, undefined);
        assert.equal(audio!.filename, 'voice.wav');
        assert.equal(audio!.type, 'audio/wav');
        assert.ok(audio!.data.equals(WAV));
    });

    it('refuses a redirect for real: the 307 is a bad_request that names it, and the address it points to is never asked (the key stays with Meta)', async () => {
        received = [];
        behave = (_req, res) => { res.writeHead(307, { location: `${origin}/elsewhere` }); res.end(); };
        const err = await failureOf(callMetaAsr({ apiKey: KEY, wav: WAV, fetchImpl: local }));
        assert.equal(err.kind, 'bad_request');
        assert.match(err.message, /redirect/i);
        assert.deepEqual(received.map((r) => r.url), ['/v1/asr/transcribe']);
    });

    it('a server that never answers ends as a timeout at the deadline, and the abort is the real one', async () => {
        received = [];
        behave = () => undefined;
        const started = Date.now();
        const err = await failureOf(callMetaAsr({ apiKey: KEY, wav: WAV, fetchImpl: local, timeoutMs: 200 }));
        assert.equal(err.kind, 'timeout');
        assert.match(err.message, /did not transcribe in time/);
        assert.ok(Date.now() - started < 5_000);
    });

    it('reads a real error answer: a 401 body that echoes the key is an auth error with the key scrubbed, and a 429 carries its Retry-After', async () => {
        received = [];
        behave = (_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}`, type: 'authentication_error' } })); };
        const auth = await failureOf(callMetaAsr({ apiKey: KEY, wav: WAV, fetchImpl: local }));
        assert.equal(auth.kind, 'auth');
        assert.ok(!auth.message.includes(KEY));

        behave = (_req, res) => { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '9' }); res.end(JSON.stringify({ error: { message: 'Concurrency limit reached' } })); };
        const rate = await failureOf(callMetaAsr({ apiKey: KEY, wav: WAV, fetchImpl: local }));
        assert.deepEqual([rate.kind, rate.retryAfterMs], ['rate', 9000]);
    });

    it('a connection that dies mid-answer is a timeout (the connection dropped), not a crash', async () => {
        received = [];
        behave = (req) => { req.socket.destroy(); };
        const err = await failureOf(callMetaAsr({ apiKey: KEY, wav: WAV, fetchImpl: local }));
        assert.equal(err.kind, 'timeout');
    });
});

describe('metaAsr.ts keeps to llm/\'s rule', () => {
    it('imports no database, no settings, no axios and nothing outside the library: the key is an argument, and where it comes from is aiProviders/asr.ts', () => {
        const source = readFileSync(new URL('./metaAsr.ts', import.meta.url), 'utf8');
        const imports = source.match(/^\s*import\b[^\n]*\bfrom\s*['"][^'"]+['"]/gm) ?? [];
        assert.ok(imports.length >= 4, imports.join('\n'));
        for (const line of imports) assert.match(line, /from\s*['"](?:\.\/[A-Za-z]+\.js|node:crypto)['"]/, line);
        assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''), /console\.|process\.env|\bpool\b/);
    });

    it('is never handed a base URL: Meta\'s address is the registry\'s, because a typed one is a place to send the key', () => {
        assert.doesNotMatch(readFileSync(new URL('./metaAsr.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''), /baseUrl\??:/);
    });
});
