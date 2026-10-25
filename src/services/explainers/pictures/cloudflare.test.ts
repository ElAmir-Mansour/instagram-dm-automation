/**
 * The Cloudflare Workers AI provider (T039, research.md R5): FLUX.2 klein 4B over the REST API, as multipart. `fetch` is injected, so nothing here
 * reaches Cloudflare. What is pinned is the request (where it goes, what it carries, and that the token travels in one header and nowhere else),
 * how the answer becomes a picture, and the two kinds of failure: the allowance is used up (error code 3036, or 4006 in older answers), or anything
 * else, a 429 that is only Cloudflare being busy (3040) included.
 */
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { describe, it } from 'node:test';
import { hangingFetch } from '../../llm/testFetch.js';
import { CLOUDFLARE_MAX_REFERENCES, CLOUDFLARE_TIMEOUT_MS, CloudflareImageProvider } from './cloudflare.js';
import { ImageProviderError, type DrawRequest } from './types.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'cf-test-token-Zk3Qw9Lm2Xp7Vb5Nc8Rt1Yh4Ud6Sg0Jf';
const MODEL = '@cf/black-forest-labs/flux-2-klein-4b';

/** A real 1×1 PNG, and the start of a JPEG: all the provider reads of the picture it gets back is what it is. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary'), Buffer.alloc(40, 9)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBPVP8 ', 'ascii'), Buffer.alloc(20)]);

interface Call { url: string; init: RequestInit }

function harness(answer: (call: Call) => Response | Promise<Response>) {
    const calls: Call[] = [];
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
        const call = { url, init };
        calls.push(call);
        return answer(call);
    };
    return { calls, fetchImpl };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const picture = (bytes: Buffer): Response => json({ result: { image: bytes.toString('base64') }, success: true, errors: [], messages: [] });
const failure = (status: number, errors: { code: number | string; message: string }[]): Response => json({ success: false, errors, messages: [], result: null }, status);

const provider = (fetchImpl: (url: string, init: RequestInit) => Promise<Response>, over: { timeoutMs?: number } = {}) =>
    new CloudflareImageProvider({ accountId: ACCOUNT, token: TOKEN, model: MODEL, dailyCap: 80, unitsPerPicture: 110 }, { fetchImpl, ...over });

const REQUEST: DrawRequest = { prompt: 'Karim reads a book.', width: 1024, height: 576, seed: 1234567 };

const form = (call: Call): FormData => {
    assert.ok(call.init.body instanceof FormData, 'the body is multipart form data');
    return call.init.body;
};

const rejection = async (run: Promise<unknown>): Promise<ImageProviderError> => {
    try { await run; } catch (err) { assert.ok(err instanceof ImageProviderError, `an ImageProviderError, not ${String(err)}`); return err; }
    assert.fail('expected the call to fail');
};

describe('CloudflareImageProvider — the request', () => {
    it('POSTs to the account’s ai/run endpoint for FLUX.2 klein 4B, with the token as a Bearer header and nothing else in the headers', async () => {
        const { calls, fetchImpl } = harness(() => picture(PNG));
        await provider(fetchImpl).draw(REQUEST);
        assert.equal(calls.length, 1);
        const [call] = calls;
        assert.equal(call!.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`);
        assert.equal(call!.init.method, 'POST');
        const headers = new Headers(call!.init.headers);
        assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
        assert.equal(headers.has('content-type'), false, 'fetch makes the multipart boundary itself; a hand-written one would be wrong');
        assert.deepEqual([...headers.keys()], ['authorization']);
    });

    it('sends the prompt, the size and the seed as form fields, and no field it was not asked for (the model’s steps are fixed at 4)', async () => {
        const { calls, fetchImpl } = harness(() => picture(PNG));
        await provider(fetchImpl).draw(REQUEST);
        const body = form(calls[0]!);
        assert.equal(body.get('prompt'), 'Karim reads a book.');
        assert.equal(body.get('width'), '1024');
        assert.equal(body.get('height'), '576');
        assert.equal(body.get('seed'), '1234567');
        assert.deepEqual([...body.keys()].sort(), ['height', 'prompt', 'seed', 'width']);
    });

    it('sends each reference as a file field input_image_0 … input_image_3, in order, with its bytes and its type', async () => {
        const { calls, fetchImpl } = harness(() => picture(PNG));
        const references = [
            { data: PNG, mime: 'image/png' as const }, { data: JPEG, mime: 'image/jpeg' as const },
            { data: PNG, mime: 'image/png' as const }, { data: JPEG, mime: 'image/jpeg' as const },
        ];
        await provider(fetchImpl).draw({ ...REQUEST, references });
        const body = form(calls[0]!);
        assert.deepEqual([...body.keys()].sort(), ['height', 'input_image_0', 'input_image_1', 'input_image_2', 'input_image_3', 'prompt', 'seed', 'width']);
        for (const [i, ref] of references.entries()) {
            const part = body.get(`input_image_${i}`);
            assert.ok(part instanceof Blob, `input_image_${i} is a file`);
            assert.equal(part.type, ref.mime);
            assert.deepEqual(Buffer.from(await part.arrayBuffer()), Buffer.from(ref.data));
        }
    });

    it('sends no input_image field when there is no reference', async () => {
        const { calls, fetchImpl } = harness(() => picture(PNG));
        await provider(fetchImpl).draw({ ...REQUEST, references: [] });
        assert.equal([...form(calls[0]!).keys()].some((key) => key.startsWith('input_image')), false);
    });

    it(`takes at most ${CLOUDFLARE_MAX_REFERENCES} references: a fifth is refused before anything is sent`, async () => {
        const { calls, fetchImpl } = harness(() => picture(PNG));
        const five = Array.from({ length: 5 }, () => ({ data: PNG, mime: 'image/png' as const }));
        const err = await rejection(provider(fetchImpl).draw({ ...REQUEST, references: five }));
        assert.equal(err.kind, 'PROVIDER_ERROR');
        assert.match(err.message, /at most 4/);
        assert.equal(calls.length, 0);
    });

    it('is given a signal that ends the call after 55 seconds (the pilot’s pictures took up to 26 s, and one passed 30)', async () => {
        assert.equal(CLOUDFLARE_TIMEOUT_MS, 55_000);
        const { calls, fetchImpl } = harness(() => picture(PNG));
        await provider(fetchImpl).draw(REQUEST);
        assert.ok(calls[0]!.init.signal instanceof AbortSignal);
    });

    it('turns a call that does not answer in time into a PROVIDER_ERROR, through that signal', async () => {
        // A server that never answers, holding the process open as a real socket does. `AbortSignal.timeout`'s timer does not, and with
        // nothing else pending Node 22's runner saw an idle event loop and cancelled this test and the 21 after it (CI, 2026-10-25).
        const hang = harness((call) => hangingFetch(call.url, call.init));
        const err = await rejection(provider(hang.fetchImpl, { timeoutMs: 25 }).draw(REQUEST));
        assert.equal(err.kind, 'PROVIDER_ERROR');
        assert.match(err.message, /did not answer in time/);
    });

    it('does not put the token anywhere but the Authorization header: not in the URL, not in a form field', async () => {
        const { calls, fetchImpl } = harness(() => picture(PNG));
        await provider(fetchImpl).draw({ ...REQUEST, references: [{ data: PNG, mime: 'image/png' }] });
        assert.equal(calls[0]!.url.includes(TOKEN), false);
        for (const [key, value] of form(calls[0]!).entries()) {
            if (typeof value === 'string') assert.equal(value.includes(TOKEN), false, key);
        }
    });
});

describe('CloudflareImageProvider — the picture that comes back', () => {
    it('decodes the base64 image of the answer and says which provider and model drew it', async () => {
        const { fetchImpl } = harness(() => picture(PNG));
        const drawn = await provider(fetchImpl).draw(REQUEST);
        assert.deepEqual(drawn.data, PNG);
        assert.equal(drawn.mime, 'image/png');
        assert.equal(drawn.provider, 'cloudflare');
        assert.equal(drawn.model, MODEL);
    });

    it('tells a JPEG from a PNG by its bytes, since the answer does not say', async () => {
        const { fetchImpl } = harness(() => picture(JPEG));
        const drawn = await provider(fetchImpl).draw(REQUEST);
        assert.equal(drawn.mime, 'image/jpeg');
        assert.deepEqual(drawn.data, JPEG);
    });

    it('also reads an image sitting directly in the answer, outside `result`', async () => {
        const { fetchImpl } = harness(() => json({ image: PNG.toString('base64') }));
        assert.deepEqual((await provider(fetchImpl).draw(REQUEST)).data, PNG);
    });

    it('refuses an answer whose bytes are not a PNG or a JPEG (a WebP is stored as neither)', async () => {
        const { fetchImpl } = harness(() => picture(WEBP));
        const err = await rejection(provider(fetchImpl).draw(REQUEST));
        assert.equal(err.kind, 'PROVIDER_ERROR');
        assert.match(err.message, /not a PNG or a JPEG/);
    });

    it('refuses an answer with no image, an empty image, an image that is not base64, and a body that is not JSON', async () => {
        for (const answer of [
            () => json({ result: {}, success: true, errors: [] }),
            () => json({ result: { image: '' }, success: true, errors: [] }),
            () => json({ result: { image: '@@@ not base64 @@@' }, success: true, errors: [] }),
            () => json({ result: { image: 12345 }, success: true, errors: [] }),
            () => new Response('<html>Bad gateway</html>', { status: 200 }),
        ]) {
            const err = await rejection(provider(harness(answer).fetchImpl).draw(REQUEST));
            assert.equal(err.kind, 'PROVIDER_ERROR');
        }
    });
});

describe('CloudflareImageProvider — the allowance is used up', () => {
    it('maps Cloudflare error code 4006 to ALLOWANCE_EXHAUSTED', async () => {
        const { fetchImpl } = harness(() => failure(400, [{ code: 4006, message: 'you have used up your daily free allocation of 10,000 neurons' }]));
        const err = await rejection(provider(fetchImpl).draw(REQUEST));
        assert.equal(err.kind, 'ALLOWANCE_EXHAUSTED');
        assert.equal(err.detail.code, 4006);
        assert.match(err.message, /allowance is used up/i);
    });

    it('maps 4006 whatever the HTTP status, and when it is a string, and when it is not the first error', async () => {
        for (const answer of [
            () => failure(403, [{ code: 4006, message: 'x' }]),
            () => failure(200, [{ code: 4006, message: 'x' }]),
            () => failure(400, [{ code: '4006', message: 'x' }]),
            () => failure(400, [{ code: 1000, message: 'other' }, { code: 4006, message: 'x' }]),
        ]) {
            const err = await rejection(provider(harness(answer).fetchImpl).draw(REQUEST));
            assert.equal(err.kind, 'ALLOWANCE_EXHAUSTED');
        }
    });

    it('maps 3036, Cloudflare\'s "Account limited" (HTTP 429), to ALLOWANCE_EXHAUSTED, as a number or a string', async () => {
        for (const code of [3036, '3036']) {
            const answer = () => failure(429, [{ code, message: 'Account limited' }]); // the code alone decides: no words to lean on
            const err = await rejection(provider(harness(answer).fetchImpl).draw(REQUEST));
            assert.equal(err.kind, 'ALLOWANCE_EXHAUSTED', String(code));
            assert.equal(err.detail.status, 429);
            assert.equal(String(err.detail.code), '3036');
        }
    });

    it('believes Cloudflare\'s words for it under a code it does not know: "daily free allocation" is ALLOWANCE_EXHAUSTED', async () => {
        const answer = () => failure(429, [{ code: 3999, message: 'You have used up your Daily Free Allocation of 10,000 neurons' }]);
        assert.equal((await rejection(provider(harness(answer).fetchImpl).draw(REQUEST))).kind, 'ALLOWANCE_EXHAUSTED');
    });

    it('takes a 429 without it for Cloudflare being busy, not for the day: 3040 (out of capacity) and a bare 429 are PROVIDER_ERROR, saying try again', async () => {
        for (const answer of [() => failure(429, [{ code: 3040, message: 'Out of capacity: no more data centers to forward the request to' }]), () => new Response('slow down', { status: 429 })]) {
            const err = await rejection(provider(harness(answer).fetchImpl).draw(REQUEST));
            assert.equal(err.kind, 'PROVIDER_ERROR');
            assert.equal(err.detail.status, 429);
            assert.match(err.message, /busy right now.*try again in a few minutes/);
        }
    });

    it('does not take other errors for exhaustion: 401, 403, 404, 500 and code 4007 are all PROVIDER_ERROR', async () => {
        for (const [status, code] of [[401, 10000], [403, 10000], [404, 7000], [500, 3000], [400, 4007], [400, 4005]] as const) {
            const err = await rejection(provider(harness(() => failure(status, [{ code, message: 'nope' }])).fetchImpl).draw(REQUEST));
            assert.equal(err.kind, 'PROVIDER_ERROR', `${status}/${code}`);
            assert.equal(err.detail.status, status);
        }
    });
});

describe('CloudflareImageProvider — other failures', () => {
    it('carries Cloudflare’s own explanation of a refusal, with the status and code for the logs', async () => {
        const { fetchImpl } = harness(() => failure(401, [{ code: 10000, message: 'Authentication error' }]));
        const err = await rejection(provider(fetchImpl).draw(REQUEST));
        assert.equal(err.kind, 'PROVIDER_ERROR');
        assert.match(err.message, /Authentication error/);
        assert.deepEqual(err.detail, { status: 401, code: 10000 });
    });

    it('says the HTTP status when the body explains nothing (a gateway page, an empty answer)', async () => {
        for (const answer of [() => new Response('<html>Bad gateway</html>', { status: 502 }), () => new Response('', { status: 503 })]) {
            const err = await rejection(provider(harness(answer).fetchImpl).draw(REQUEST));
            assert.equal(err.kind, 'PROVIDER_ERROR');
            assert.match(err.message, /HTTP 50[23]/);
        }
    });

    it('says the call could not be made when the network fails', async () => {
        const err = await rejection(provider(async () => { throw new TypeError('fetch failed'); }).draw(REQUEST));
        assert.equal(err.kind, 'PROVIDER_ERROR');
        assert.match(err.message, /could not be reached/);
    });

    it('clips a long explanation, so a page of HTML never becomes the owner’s error message', async () => {
        const err = await rejection(provider(harness(() => failure(400, [{ code: 5000, message: 'x'.repeat(5000) }])).fetchImpl).draw(REQUEST));
        assert.ok(err.message.length <= 400, `${err.message.length} characters`);
    });
});

describe('CloudflareImageProvider — the token', () => {
    it('never appears in an error: not when Cloudflare echoes it, not when the network error quotes the request', async () => {
        const echoing = harness(() => failure(401, [{ code: 10000, message: `Invalid token ${TOKEN} for this account` }]));
        const e1 = await rejection(provider(echoing.fetchImpl).draw(REQUEST));
        assert.equal(e1.message.includes(TOKEN), false);
        assert.equal(JSON.stringify(e1.detail).includes(TOKEN), false);
        assert.match(e1.message, /\[redacted\]/);

        const quoting = provider(async () => { throw new Error(`request to https://x failed, headers: {authorization: "Bearer ${TOKEN}"}`); });
        const e2 = await rejection(quoting.draw(REQUEST));
        assert.equal(e2.message.includes(TOKEN), false);
        assert.equal(String(e2.stack).includes(TOKEN), false);
    });

    it('is not on the provider object where JSON or a log line would find it', () => {
        const p = provider(harness(() => picture(PNG)).fetchImpl);
        assert.equal(JSON.stringify(p).includes(TOKEN), false);
        assert.equal(inspect(p, { depth: 5, showHidden: true }).includes(TOKEN), false);
        assert.equal(String(p).includes(TOKEN), false);
        assert.deepEqual(Object.keys(p).sort(), ['dailyCap', 'id', 'model', 'unitsPerPicture']);
    });
});

describe('CloudflareImageProvider — what it is', () => {
    it('is the `cloudflare` provider, with the model, the daily cap and the units of a picture it was given', () => {
        const p = provider(harness(() => picture(PNG)).fetchImpl);
        assert.equal(p.id, 'cloudflare');
        assert.equal(p.model, MODEL);
        assert.equal(p.dailyCap, 80);
        assert.equal(p.unitsPerPicture, 110);
    });

    it('will not be built with an account id or a model that could change where the request goes', () => {
        const make = (accountId: string, model: string) => () => new CloudflareImageProvider({ accountId, token: TOKEN, model, dailyCap: 80, unitsPerPicture: 110 });
        for (const bad of ['', 'abc', `${ACCOUNT}/../../other`, `${ACCOUNT}?x=1`, `${ACCOUNT}#frag`, 'has space in it 0123456789', '../../etc']) {
            assert.throws(make(bad, MODEL), /account id/i, bad);
        }
        for (const bad of ['', 'flux', '@cf/black-forest-labs', '@cf/a/b/../c', '@cf/a/b?x=1', 'cf/black-forest-labs/flux-2-klein-4b', '@cf/../..', '@cf/./x', '@cf/a/..']) {
            assert.throws(make(ACCOUNT, bad), /model/i, bad);
        }
        assert.doesNotThrow(make(ACCOUNT, MODEL));
    });

    it('will not be built with an empty token', () => {
        assert.throws(() => new CloudflareImageProvider({ accountId: ACCOUNT, token: '', model: MODEL, dailyCap: 80, unitsPerPicture: 110 }), /token/i);
    });
});
