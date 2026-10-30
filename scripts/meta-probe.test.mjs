/**
 * The Meta probe (scripts/meta-probe.mjs), WITHOUT its network: what it builds (a PNG, a WAV, a multipart body, the request of each check), how
 * it judges an answer, and that nothing it prints can hold the key. The probe itself calls the live API with the owner's key and is never run from
 * here; every call below goes to a stub.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';
import {
    ASR_MODEL, BASE_URL, CHECKS, crc32, errorCode, IMAGE_MODEL, makeRedactor, MAX_TOKENS, MODEL, multipart, parseChecks, pngOfDigits, requests, runChecks,
    selectChecks, summarise, verdicts, wavTone,
} from './meta-probe.mjs';

const KEY = 'probe-key-Hb7vQm3xTz9RnYd2KfP5aLc8JgSe4UoWiNtXrBwEs6Vq';

describe('importing the probe', () => {
    it('does nothing: no request, no database, no exit code, so `npm test` can read it', async () => {
        const realFetch = globalThis.fetch;
        let called = 0;
        globalThis.fetch = () => { called++; throw new Error('the probe must not call fetch on import'); };
        const before = process.exitCode;
        try {
            const fresh = await import(`./meta-probe.mjs?fresh=${Date.now()}`);
            assert.equal(typeof fresh.runChecks, 'function');
        } finally {
            globalThis.fetch = realFetch;
        }
        assert.equal(called, 0);
        assert.equal(process.exitCode, before);
    });

    it('names the checks the brief names, in the order they run', () => {
        assert.deepEqual(CHECKS, ['models', 'text', 'strict_json', 'image', 'video', 'asr', 'image_generation']);
    });
});

describe('the PNG it draws', () => {
    /** A PNG read the way a decoder would: signature, then every chunk with its CRC checked. */
    function chunks(png) {
        assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'the PNG signature');
        const out = [];
        for (let at = 8; at < png.length;) {
            const length = png.readUInt32BE(at);
            const type = png.toString('ascii', at + 4, at + 8);
            const data = png.subarray(at + 8, at + 8 + length);
            assert.equal(png.readUInt32BE(at + 8 + length), crc32(png.subarray(at + 4, at + 8 + length)), `the CRC of ${type}`);
            out.push({ type, data });
            at += 12 + length;
        }
        return out;
    }

    it('is a valid PNG: IHDR, one IDAT that inflates to exactly the rows, and IEND, every CRC right', () => {
        const parts = chunks(pngOfDigits('42'));
        assert.deepEqual(parts.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
        const ihdr = parts[0].data;
        const [width, height] = [ihdr.readUInt32BE(0), ihdr.readUInt32BE(4)];
        assert.deepEqual([...ihdr.subarray(8)], [8, 0, 0, 0, 0], '8-bit grayscale, deflate, adaptive filtering, no interlace');
        const raw = zlib.inflateSync(parts[1].data);
        assert.equal(raw.length, height * (1 + width));
        for (let y = 0; y < height; y++) assert.equal(raw[y * (1 + width)], 0, `row ${y} is unfiltered`);
        assert.equal(parts[2].data.length, 0);
    });

    it('has black digits on white, with a white margin all round, and different digits give different pictures', () => {
        const png = pngOfDigits('42');
        const ihdr = chunks(png)[0].data;
        const [width, height] = [ihdr.readUInt32BE(0), ihdr.readUInt32BE(4)];
        const raw = zlib.inflateSync(chunks(png)[1].data);
        const pixel = (x, y) => raw[y * (1 + width) + 1 + x];
        const black = [...raw].filter((v, i) => i % (1 + width) !== 0 && v === 0).length;
        const white = [...raw].filter((v, i) => i % (1 + width) !== 0 && v === 255).length;
        assert.ok(black > 1000 && white > black, `${black} black, ${white} white`);
        assert.equal(black + white, width * height, 'only black and white');
        for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) assert.equal(pixel(x, y), 255);
        assert.notDeepEqual(pngOfDigits('42'), pngOfDigits('24'));
        assert.deepEqual(pngOfDigits('42'), pngOfDigits('42'), 'drawn the same way every time');
    });

    it('draws a digit scale pixels square, so the picture is big enough to read', () => {
        const small = chunks(pngOfDigits('4', { scale: 4 }))[0].data;
        const large = chunks(pngOfDigits('4', { scale: 12 }))[0].data;
        assert.ok(large.readUInt32BE(0) > small.readUInt32BE(0) * 2);
        assert.ok(large.readUInt32BE(0) >= 100 && large.readUInt32BE(4) >= 100);
    });

    it('refuses anything that is not one to eight digits', () => {
        for (const bad of ['', 'ab', '4 2', '123456789', '-1', '4.2']) assert.throws(() => pngOfDigits(bad), /1 to 8 of 0-9/, JSON.stringify(bad));
    });

    it('has the CRC-32 PNG wants (the check value of "123456789")', () => {
        assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
        assert.equal(crc32(Buffer.alloc(0)), 0);
    });
});

describe('the WAV it generates', () => {
    it('is RIFF/WAVE, PCM, mono, 16-bit, 24 kHz: the only audio the transcription endpoint takes', () => {
        const wav = wavTone();
        assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
        assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
        assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
        assert.equal(wav.readUInt32LE(16), 16);
        assert.equal(wav.readUInt16LE(20), 1, 'PCM');
        assert.equal(wav.readUInt16LE(22), 1, 'mono');
        assert.equal(wav.readUInt32LE(24), 24000);
        assert.equal(wav.readUInt32LE(28), 48000, 'byte rate');
        assert.equal(wav.readUInt16LE(32), 2, 'block align');
        assert.equal(wav.readUInt16LE(34), 16, 'bits');
        assert.equal(wav.toString('ascii', 36, 40), 'data');
        const bytes = wav.readUInt32LE(40);
        assert.equal(bytes, wav.length - 44);
        assert.equal(wav.readUInt32LE(4), wav.length - 8, 'the RIFF size');
        assert.equal(bytes / 2 / 24000, 1.5, 'seconds');
    });

    it('carries a tone that is neither silence nor clipping', () => {
        const wav = wavTone({ seconds: 0.5 });
        let peak = 0;
        for (let at = 44; at < wav.length; at += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(at)));
        assert.ok(peak > 5000 && peak < 32767, String(peak));
    });

    it('takes 16 kHz too, and a length', () => {
        const wav = wavTone({ seconds: 2, rate: 16000 });
        assert.equal(wav.readUInt32LE(24), 16000);
        assert.equal((wav.length - 44) / 2 / 16000, 2);
    });
});

describe('the multipart body', () => {
    const wav = wavTone({ seconds: 0.1 });
    const form = multipart([
        { name: 'request', type: 'application/json', data: '{"a":1}' },
        { name: 'audio', filename: 'probe.wav', type: 'audio/wav', data: wav },
    ], 'BOUNDARY');

    it('is what the endpoint was tried with: a JSON request part with no filename, then the audio as a file, closed by the final boundary', () => {
        assert.equal(form.contentType, 'multipart/form-data; boundary=BOUNDARY');
        const text = form.body.toString('latin1');
        assert.ok(text.startsWith('--BOUNDARY\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n{"a":1}\r\n--BOUNDARY\r\n'));
        assert.ok(text.includes('Content-Disposition: form-data; name="audio"; filename="probe.wav"\r\nContent-Type: audio/wav\r\n\r\n'));
        assert.ok(text.endsWith('\r\n--BOUNDARY--\r\n'));
        assert.ok(!text.includes('name="request"; filename'));
    });

    it('holds the audio bytes untouched', () => {
        assert.ok(form.body.includes(wav));
    });

    it('makes a boundary of its own when it is given none, and never the same twice', () => {
        const a = multipart([{ name: 'x', type: 'text/plain', data: 'y' }]);
        const b = multipart([{ name: 'x', type: 'text/plain', data: 'y' }]);
        assert.match(a.boundary, /^probe[0-9a-f]{24}$/);
        assert.notEqual(a.boundary, b.boundary);
    });
});

describe('the request of each check', () => {
    it('asks Muse Spark 1.3 for low effort and room to think: 4 000 tokens, which is what an answer needs', () => {
        assert.equal(MODEL, 'muse-spark-1.3');
        assert.equal(MAX_TOKENS, 4000);
        for (const body of [requests.text(), requests.strict_json(), requests.image(Buffer.from('x')), requests.video(Buffer.from('x'))]) {
            assert.equal(body.model, 'muse-spark-1.3');
            assert.equal(body.max_tokens, 4000);
            assert.equal(body.reasoning_effort, 'low');
        }
    });

    it('asks for strict JSON in the nested shape, every property required and no extras', () => {
        const format = requests.strict_json().response_format;
        assert.equal(format.type, 'json_schema');
        assert.equal(format.json_schema.strict, true);
        assert.equal(format.json_schema.schema.additionalProperties, false);
        assert.deepEqual(format.json_schema.schema.required, ['ok', 'word']);
    });

    it('sends the picture and the video as base64 data URLs after the question, never as a link', () => {
        const png = pngOfDigits('42');
        const [question, picture] = requests.image(png).messages[0].content;
        assert.equal(question.type, 'text');
        assert.equal(picture.type, 'image_url');
        assert.ok(picture.image_url.url.startsWith('data:image/png;base64,'));
        assert.deepEqual(Buffer.from(picture.image_url.url.split(',')[1], 'base64'), png);
        const mp4 = Buffer.from('not really a clip');
        const [, clip] = requests.video(mp4).messages[0].content;
        assert.equal(clip.type, 'video_url');
        assert.ok(clip.video_url.url.startsWith('data:video/mp4;base64,'));
        assert.deepEqual(Buffer.from(clip.video_url.url.split(',')[1], 'base64'), mp4);
        assert.ok(!JSON.stringify(requests.image(png)).includes('http'));
    });

    it('names the speech and image models, with the languages and keywords the voice notes will use', () => {
        assert.deepEqual(requests.asr(), { model: ASR_MODEL, audioEncoding: 'WAV', languageBias: ['Arabic', 'English'], keywords: ['probe'] });
        assert.equal(ASR_MODEL, 'muse-voice-transcribe-1.0');
        const generation = requests.image_generation();
        assert.deepEqual([generation.model, generation.n, generation.size], [IMAGE_MODEL, 1, '1024x1024']);
        assert.equal(IMAGE_MODEL, 'muse-image-1.0');
        assert.match(generation.prompt, /no people/);
    });
});

describe('what counts as a pass', () => {
    const chatAnswer = (content, finish = 'stop') => ({ choices: [{ finish_reason: finish, message: { content } }] });

    it('models: the list names muse-spark-1.3', () => {
        assert.equal(verdicts.models({ data: [{ id: 'sam-3.1' }, { id: 'muse-spark-1.3' }] }).ok, true);
        assert.equal(verdicts.models({ data: [{ id: 'sam-3.1' }] }).ok, false);
        assert.equal(verdicts.models(null).ok, false);
    });

    it('text and video: some text came back, and a cut-off answer (the thinking used the limit) is a failure that says so', () => {
        for (const check of [verdicts.text, verdicts.video]) {
            assert.equal(check(chatAnswer('أهلاً')).ok, true);
            assert.equal(check(chatAnswer('   ')).ok, false);
            assert.equal(check(chatAnswer(null)).ok, false);
            assert.equal(check({}).ok, false);
        }
        const cut = verdicts.text(chatAnswer(null, 'length'));
        assert.equal(cut.ok, false);
        assert.match(cut.why, /finish_reason length/);
    });

    it('strict_json: JSON of the shape asked for, and nothing else', () => {
        assert.equal(verdicts.strict_json(chatAnswer('{"ok":true,"word":"four"}')).ok, true);
        assert.equal(verdicts.strict_json(chatAnswer('{"ok":"yes","word":"four"}')).ok, false);
        assert.equal(verdicts.strict_json(chatAnswer('four')).ok, false);
        assert.equal(verdicts.strict_json(chatAnswer(null, 'length')).ok, false);
    });

    it('image: the answer holds the number that was drawn', () => {
        assert.equal(verdicts.image(chatAnswer('42')).ok, true);
        assert.equal(verdicts.image(chatAnswer('The number is 42.')).ok, true);
        assert.equal(verdicts.image(chatAnswer('24')).ok, false);
        assert.equal(verdicts.image(chatAnswer('142')).ok, false);
        assert.equal(verdicts.image(chatAnswer('')).ok, false);
    });

    it('asr: a transcript field (empty is fine for a tone) and a duration', () => {
        assert.equal(verdicts.asr({ transcript: '', audioDurationMs: 1500 }).ok, true);
        assert.equal(verdicts.asr({ transcript: 'x' }).ok, false);
        assert.equal(verdicts.asr({ audioDurationMs: 1500 }).ok, false);
        assert.equal(verdicts.asr({ transcript: '', audioDurationMs: 0 }).ok, false);
    });

    it('image_generation: an image came back as base64', () => {
        assert.equal(verdicts.image_generation({ data: [{ b64_json: 'A'.repeat(200) }] }).ok, true);
        assert.equal(verdicts.image_generation({ data: [{ b64_json: 'AAAA' }] }).ok, false);
        assert.equal(verdicts.image_generation({ data: [] }).ok, false);
    });

    it('says what was missing and never what was said: no verdict quotes the answer', () => {
        const secret = 'THE-MODEL-SAID-THIS';
        for (const [name, check] of Object.entries(verdicts)) {
            const result = check(chatAnswer(secret, 'length'));
            if (!result.ok) assert.ok(!String(result.why).includes(secret), name);
        }
    });
});

describe('choosing the checks', () => {
    it('reads a list, and reports a name that is not a check instead of running everything', () => {
        assert.deepEqual(parseChecks('text, image ,video'), { names: ['text', 'image', 'video'], unknown: [] });
        assert.deepEqual(parseChecks('text,nope'), { names: ['text'], unknown: ['nope'] });
        assert.deepEqual(parseChecks(undefined), { names: [], unknown: [] });
        assert.deepEqual(parseChecks(true), { names: [], unknown: [] });
    });

    it('runs all of them by default, only the ones asked for in the canonical order, and all but the skipped', () => {
        assert.deepEqual(selectChecks({}), CHECKS);
        assert.deepEqual(selectChecks({ only: parseChecks('image,text') }), ['text', 'image']);
        assert.deepEqual(selectChecks({ skip: parseChecks('image_generation,video') }), ['models', 'text', 'strict_json', 'image', 'asr']);
        assert.deepEqual(selectChecks({ only: parseChecks('text,image'), skip: parseChecks('image') }), ['text']);
    });
});

describe('runChecks against a stub', () => {
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const chat = (content, usage = {}) => json(200, { choices: [{ finish_reason: 'stop', message: { content } }], usage });
    /** The answers of a healthy API, by path. */
    const healthy = (url, init) => {
        const { pathname } = new URL(url);
        if (pathname === '/v1/models') return json(200, { data: [{ id: MODEL }] });
        if (pathname === '/v1/asr/transcribe') return json(200, { transcript: '', audioDurationMs: 1500 });
        if (pathname === '/v1/images/generations') return json(200, { data: [{ b64_json: 'A'.repeat(300) }] });
        const body = JSON.parse(init.body);
        if (body.response_format) return chat('{"ok":true,"word":"four"}');
        if (JSON.stringify(body.messages).includes('image_url')) return chat('42');
        return chat('hello');
    };
    const recording = (answer) => {
        const calls = [];
        const fetchImpl = async (url, init) => { calls.push({ url, init }); return answer(url, init); };
        return { fetchImpl, calls };
    };
    const run = async (answer, over = {}) => {
        const lines = [];
        const { fetchImpl, calls } = recording(answer);
        const report = await runChecks({ key: KEY, names: CHECKS, fetchImpl, getClip: async () => Buffer.from('clip'), out: (line) => lines.push(line), ...over });
        return { report, lines, calls };
    };

    it('passes every check against a healthy API, with a latency on each line, and exits 0', async () => {
        const { report, lines } = await run(healthy);
        assert.deepEqual(Object.values(report.checks).map((c) => c.status), Array(7).fill('PASS'));
        assert.equal(lines.length, 7);
        for (const line of lines) assert.match(line, /^PASS {2}\S+ +\d+\.\d s$/);
        assert.deepEqual(summarise(report), { line: '7 passed · 0 failed · 0 skipped', code: 0 });
    });

    it('sends every request to api.meta.ai/v1 with the key in the Authorization header and nowhere else', async () => {
        const { calls } = await run(healthy);
        assert.equal(calls.length, 7);
        for (const { url, init } of calls) {
            assert.ok(url.startsWith(`${BASE_URL}/`), url);
            assert.equal(init.headers.authorization, `Bearer ${KEY}`);
            assert.ok(!url.includes(KEY));
            assert.ok(!String(init.body ?? '').includes(KEY));
            assert.equal(init.redirect, 'error', 'a redirect would carry the key elsewhere');
            assert.ok(init.signal instanceof AbortSignal);
        }
        assert.deepEqual(calls.map((c) => [c.init.method, new URL(c.url).pathname]), [
            ['GET', '/v1/models'], ['POST', '/v1/chat/completions'], ['POST', '/v1/chat/completions'], ['POST', '/v1/chat/completions'],
            ['POST', '/v1/chat/completions'], ['POST', '/v1/asr/transcribe'], ['POST', '/v1/images/generations'],
        ]);
        assert.match(calls[5].init.headers['content-type'], /^multipart\/form-data; boundary=probe[0-9a-f]{24}$/);
    });

    it('fails a check with the HTTP status and Meta\'s error code only: its message, which can echo a request or the key, is not printed', async () => {
        const echo = `Invalid API key ${KEY} in request`;
        const { report, lines } = await run((url) => (new URL(url).pathname === '/v1/models' ? json(401, { error: { message: echo, type: 'invalid_request_error', code: 'invalid_api_key' } }) : healthy(url, {})), { names: ['models'] });
        assert.deepEqual(report.checks.models.status, 'FAIL');
        assert.equal(lines.length, 1);
        assert.match(lines[0], /^FAIL {2}models +\d+\.\d s {2}HTTP 401 invalid_api_key$/);
        assert.ok(!lines.join('\n').includes('Invalid API key'));
        assert.ok(!JSON.stringify(report).includes(KEY));
        assert.equal(summarise(report).code, 1);
    });

    it('never prints the key, whatever the server says and whatever a verdict reports', async () => {
        const hostile = (url) => json(200, { choices: [{ finish_reason: 'length', message: { content: KEY } }], error: { message: KEY, code: KEY }, transcript: KEY, data: [{ id: KEY }] });
        const { report, lines } = await run(hostile);
        assert.ok(!(lines.join('\n') + JSON.stringify(report)).includes(KEY));
        const failing = await run(() => json(500, { error: { code: KEY, type: KEY } }));
        assert.ok(!(failing.lines.join('\n') + JSON.stringify(failing.report)).includes(KEY));
        // Even a line built with the key in it is redacted on the way out.
        const lines2 = [];
        await runChecks({ key: KEY, names: ['models'], fetchImpl: async () => json(403, { error: { code: `x-${KEY}` } }), out: (l) => lines2.push(l) });
        assert.ok(!lines2.join('\n').includes(KEY));
        assert.match(lines2.join('\n'), /\[redacted\]/);
    });

    it('reports a cut-off answer as a failure that names the limit, a timeout, and a dropped connection, and goes on to the next check', async () => {
        const answers = [
            () => chat(null),
            () => json(200, { choices: [{ finish_reason: 'length', message: { content: null } }] }),
            () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); },
            () => { throw new TypeError('fetch failed'); },
        ];
        let at = 0;
        const { report, lines } = await run(() => answers[at++ % answers.length](), { names: ['text', 'text', 'models', 'asr'] });
        assert.equal(lines.length, 4);
        assert.match(lines[1], /FAIL .*finish_reason length/);
        assert.match(lines[2], /FAIL .*timeout$/);
        assert.match(lines[3], /FAIL .*no answer \(TypeError\)$/);
        assert.equal(summarise(report).code, 1);
    });

    it('skips the video check, without failing the run, when there is no clip', async () => {
        const { report, lines, calls } = await run(healthy, { names: ['video', 'text'], getClip: async () => null });
        assert.equal(report.checks.video.status, 'SKIP');
        assert.match(lines[0], /^SKIP {2}video +no clip: ffmpeg is not installed, or the file could not be read\. Pass --video <file\.mp4>$/);
        assert.equal(calls.length, 1, 'nothing was sent for it');
        assert.deepEqual(summarise(report), { line: '1 passed · 0 failed · 1 skipped', code: 0 });
    });

    it('sends the generated media and nothing of anyone\'s: a PNG of 42, a clip it was given, a tone', async () => {
        const { calls } = await run(healthy);
        const image = JSON.parse(calls[3].init.body).messages[0].content[1].image_url.url;
        assert.deepEqual(Buffer.from(image.split(',')[1], 'base64'), pngOfDigits('42'));
        assert.deepEqual(Buffer.from(JSON.parse(calls[4].init.body).messages[0].content[1].video_url.url.split(',')[1], 'base64'), Buffer.from('clip'));
        assert.ok(calls[5].init.body.includes(wavTone()));
    });
});

describe('what is printed', () => {
    it('removes every occurrence of the key, and leaves what is too short to be one', () => {
        const redact = makeRedactor([KEY, 'abc']);
        assert.equal(redact(`a ${KEY} b ${KEY}`), 'a [redacted] b [redacted]');
        assert.equal(redact('abc stays'), 'abc stays');
        assert.equal(makeRedactor([])('nothing to hide'), 'nothing to hide');
    });

    it('reads Meta\'s error as a code, and never as its message', () => {
        assert.equal(errorCode({ error: { message: 'secret words', code: 'invalid_api_key', type: 'x' } }), 'invalid_api_key');
        assert.equal(errorCode({ error: { message: 'secret words', type: 'rate_limit_error' } }), 'rate_limit_error');
        assert.equal(errorCode({ error: { message: 'secret words' } }), 'error');
        assert.equal(errorCode({ error: 'a string' }), 'error');
        assert.equal(errorCode(null), 'no error body');
        assert.equal(errorCode({ error: { code: 'x'.repeat(200) } }).length, 60);
    });
});
