/**
 * `saveInboundMedia`: a customer's file, from Meta's URL to a private upload (docs/specs/001-whatsapp-agent T016, review H4).
 *
 * `metaHttp.get` is replaced for the whole file (it throws on a call no test arranged: `.env` holds live credentials) and the media store
 * is an in-memory stand-in that records what it was asked to put. What is pinned: the file is stored PRIVATE; an expired URL (404) is asked
 * for once more; the size cap and the type list; and, last, that neither the token nor the signed URL's query is ever logged, returned or
 * kept, however the call fails.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../utils/log.js';
import { metaHttp } from './http.js';
import { API_VERSION } from './instagram.js';
import { setMediaStore, type MediaStore, type PutMediaInput } from './storage.js';
import { MAX_INBOUND_MEDIA_BYTES, safeDetail, saveInboundMedia, SAVEABLE_TYPES } from './whatsappMedia.js';

const BASE = `https://graph.facebook.com/${API_VERSION}`;
const TOKEN = 'EAAGwhatsapp-system-user-token-0123456789';
const CREATOR = '11111111-1111-4111-8111-111111111111';
const PHONE = '106540352242922';
const MEDIA = '1013859600285441';
const SIGNED = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1013859600285441&ext=1760000000&hash=SIGNED-SECRET-HASH';
const SIGNED_2 = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1013859600285441&ext=1760000300&hash=SECOND-SIGNED-HASH';
const VOICE = Buffer.from('OggS-opus-voice-note-bytes');

interface Recorded { url: string; config: any }
let calls: Recorded[];
let onGet: (url: string, config: any) => Promise<any>;
let puts: PutMediaInput[];
let putFails: Error | null;
let logged: string[];

const original = { get: metaHttp.get };
let restoreSink: (() => void) | undefined;
let previousStore: MediaStore | null = null;

before(() => {
    const previous = setLogSink((_level, line) => { logged.push(line); });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    calls = [];
    logged = [];
    puts = [];
    putFails = null;
    onGet = async (url) => { throw new Error(`no GET was arranged for ${url}`); };
    (metaHttp as any).get = (url: string, config: any) => { calls.push({ url, config }); return onGet(url, config); };
    previousStore = setMediaStore({
        async put(input) {
            if (putFails) throw putFails;
            puts.push(input);
            return { id: '9b8a7a0e-3c1f-4f7e-9d0a-1234567890ab' };
        },
        async get() { return null; },
        async open() { return null; },
        async mimeTypes() { return new Map(); },
        publicUrl(id, origin) { return `${origin}/api/uploads/${id}`; },
    });
});

afterEach(() => {
    (metaHttp as any).get = original.get;
    setMediaStore(previousStore);
});

/** An axios-shaped failure. 404 and 400 are never retried by `withRetry`, so no test sits through a backoff. */
const axiosFailure = (status: number | undefined, message: string, data?: unknown) =>
    Object.assign(new Error(message), {
        isAxiosError: true,
        ...(status ? { response: { status, data } } : {}),
        // What a real axios error carries, and why it must never be logged: the request's headers and its URL.
        config: { url: SIGNED, headers: { Authorization: `Bearer ${TOKEN}` } },
    });

/** Graph answers the lookup; the CDN answers the download. */
function arrange(over: { info?: Record<string, unknown>; bytes?: Buffer; download?: (url: string) => Promise<any> } = {}) {
    onGet = async (url) => {
        if (url === `${BASE}/${MEDIA}`) {
            return { data: { id: MEDIA, url: SIGNED, mime_type: 'audio/ogg; codecs=opus', sha256: 'abc', file_size: VOICE.length, ...over.info } };
        }
        if (over.download) return over.download(url);
        return { data: over.bytes ?? VOICE, headers: { 'content-type': 'audio/ogg' } };
    };
}

const save = (over: Partial<Parameters<typeof saveInboundMedia>[0]> = {}) =>
    saveInboundMedia({ creatorId: CREATOR, phoneNumberId: PHONE, token: TOKEN, mediaId: MEDIA, mime: 'audio/ogg; codecs=opus', ...over });

describe('saveInboundMedia: the happy path', () => {
    it('looks the URL up for this phone number, downloads with the bearer token, and stores the file PRIVATE', async () => {
        arrange();

        const result = await save();

        assert.deepEqual(result, { ok: true, uploadId: '9b8a7a0e-3c1f-4f7e-9d0a-1234567890ab', mimeType: 'audio/ogg', bytes: VOICE.length });
        assert.equal(calls.length, 2, 'one lookup, one download');
        assert.equal(calls[0]!.url, `${BASE}/${MEDIA}`);
        assert.deepEqual(calls[0]!.config.params, { phone_number_id: PHONE }, 'Meta answers only for a file of this number');
        assert.equal(calls[1]!.url, SIGNED);
        assert.equal(calls[1]!.config.headers.Authorization, `Bearer ${TOKEN}`);
        assert.equal(calls[1]!.config.responseType, 'arraybuffer');
        assert.equal(calls[1]!.config.maxContentLength, MAX_INBOUND_MEDIA_BYTES, 'the download itself is capped, whatever Meta announced');

        assert.equal(puts.length, 1);
        assert.equal(puts[0]!.private, true, 'a customer\'s file is never stored public');
        assert.equal(puts[0]!.creatorId, CREATOR);
        assert.equal(puts[0]!.mimeType, 'audio/ogg', 'without the codecs parameter');
        assert.equal(puts[0]!.filename, `whatsapp-${MEDIA}.ogg`);
        assert.deepEqual(puts[0]!.data, VOICE);
    });

    it('takes the type from Meta\'s answer, falling back to the webhook\'s, and stores only a type it knows (never the sender\'s free text)', async () => {
        arrange({ info: { mime_type: undefined } });
        assert.equal((await save({ mime: 'Audio/Ogg; codecs=opus' })).ok, true);
        assert.equal(puts[0]!.mimeType, 'audio/ogg');
        assert.ok(SAVEABLE_TYPES.has('audio/ogg') && SAVEABLE_TYPES.has('image/jpeg') && SAVEABLE_TYPES.has('application/pdf'));
        assert.ok(![...SAVEABLE_TYPES].some((t) => t === 'text/html' || t.includes('script') || t.includes('svg')), 'nothing that a browser would run');
    });
});

describe('saveInboundMedia: the URL lives five minutes', () => {
    it('asks for a fresh URL ONCE when the download is a 404, and downloads from the new one', async () => {
        let downloads = 0;
        let lookups = 0;
        onGet = async (url) => {
            if (url === `${BASE}/${MEDIA}`) {
                lookups++;
                return { data: { id: MEDIA, url: lookups === 1 ? SIGNED : SIGNED_2, mime_type: 'audio/ogg', file_size: VOICE.length } };
            }
            downloads++;
            if (url === SIGNED) throw axiosFailure(404, 'Request failed with status code 404');
            return { data: VOICE, headers: {} };
        };

        const result = await save();

        assert.equal(result.ok, true);
        assert.deepEqual(calls.map((c) => c.url), [`${BASE}/${MEDIA}`, SIGNED, `${BASE}/${MEDIA}`, SIGNED_2]);
        assert.equal(lookups, 2);
        assert.equal(downloads, 2);
        assert.equal(puts.length, 1);
    });

    it('gives up on a second 404: not_found, not retryable, nothing stored', async () => {
        arrange({ download: async () => { throw axiosFailure(404, 'Request failed with status code 404'); } });
        const result = await save();
        assert.deepEqual(result, { ok: false, reason: 'not_found', retryable: false, detail: result.ok ? undefined : result.detail });
        assert.equal(calls.length, 4, 'lookup, download, lookup, download: and no third try');
        assert.equal(puts.length, 0);
    });

    it('is not_found, with no download, when Meta no longer has the media id (404, or code 100)', async () => {
        onGet = async () => { throw axiosFailure(404, 'Request failed with status code 404'); };
        const gone = await save();
        assert.equal(gone.ok === false && gone.reason, 'not_found');
        assert.equal(gone.ok === false && gone.retryable, false);

        calls = [];
        onGet = async () => { throw axiosFailure(400, 'Bad request', { error: { message: 'Unsupported get request', code: 100, error_subcode: 33 } }); };
        const unsupported = await save();
        assert.equal(unsupported.ok === false && unsupported.reason, 'not_found');
        assert.equal(calls.length, 1);
        assert.equal(puts.length, 0);
    });

    it('is auth, not retryable, when the token is dead (code 190)', async () => {
        onGet = async () => { throw axiosFailure(400, 'Bad request', { error: { message: 'Error validating access token', code: 190 } }); };
        const result = await save();
        assert.equal(result.ok === false && result.reason, 'auth');
        assert.equal(result.ok === false && result.retryable, false);
    });

    it('is retryable when the failure may pass: a lookup or a download that broke without an answer', async () => {
        onGet = async () => { throw axiosFailure(undefined, 'socket hang up'); };
        const lookup = await save();
        assert.equal(lookup.ok === false && lookup.reason, 'lookup_failed');
        assert.equal(lookup.ok === false && lookup.retryable, true);

        arrange({ download: async () => { throw axiosFailure(undefined, 'socket hang up'); } });
        const download = await save();
        assert.equal(download.ok === false && download.reason, 'download_failed');
        assert.equal(download.ok === false && download.retryable, true);
        assert.equal(puts.length, 0);
    });
});

describe('saveInboundMedia: what it will not save', () => {
    it('skips a file Meta announces as over 16 MB, before a byte is downloaded', async () => {
        arrange({ info: { file_size: MAX_INBOUND_MEDIA_BYTES + 1 } });
        const result = await save();
        assert.deepEqual(result, { ok: false, reason: 'too_large', retryable: false });
        assert.equal(calls.length, 1, 'only the lookup');
        assert.equal(puts.length, 0);
    });

    it('skips a file that turns out bigger than announced: by the download\'s own limit, and by the bytes that arrived', async () => {
        arrange({ download: async () => { throw axiosFailure(undefined, 'maxContentLength size of 16777216 exceeded'); } });
        const refused = await save();
        assert.equal(refused.ok === false && refused.reason, 'too_large');
        assert.equal(refused.ok === false && refused.retryable, false);

        arrange({ bytes: Buffer.alloc(MAX_INBOUND_MEDIA_BYTES + 1) });
        const oversized = await save();
        assert.equal(oversized.ok === false && oversized.reason, 'too_large');
        assert.equal(puts.length, 0);
    });

    it('stores a file of exactly the cap', async () => {
        arrange({ info: { file_size: MAX_INBOUND_MEDIA_BYTES }, bytes: Buffer.alloc(MAX_INBOUND_MEDIA_BYTES, 1) });
        assert.equal((await save()).ok, true);
    });

    it('skips a type that is not on the list, by Meta\'s word over the webhook\'s: nothing is downloaded or stored', async () => {
        for (const mime of ['text/html', 'application/x-msdownload', 'image/svg+xml', 'application/octet-stream', '']) {
            calls = [];
            arrange({ info: { mime_type: mime || undefined } });
            const result = await save({ mime: mime || null });
            assert.equal(result.ok === false && result.reason, 'unsupported_type', mime);
            assert.equal(result.ok === false && result.retryable, false);
            assert.equal(calls.length, 1, `${mime}: no download`);
        }
        // The webhook said audio; Meta says html. Meta wins.
        arrange({ info: { mime_type: 'text/html' } });
        assert.equal((await save({ mime: 'audio/ogg' })).ok, false);
        assert.equal(puts.length, 0);
    });

    it('refuses an empty download rather than storing a zero-byte file', async () => {
        arrange({ info: { file_size: 0 }, bytes: Buffer.alloc(0) });
        const result = await save();
        assert.equal(result.ok === false && result.reason, 'download_failed');
        assert.equal(puts.length, 0);
    });

    it('refuses ids that are not ids, before any call', async () => {
        for (const over of [
            { creatorId: 'not-a-uuid' }, { creatorId: '' }, { phoneNumberId: 'abc' }, { phoneNumberId: '1/../2' },
            { mediaId: '1/../../me' }, { mediaId: '' }, { token: '' },
        ]) {
            const result = await save(over);
            assert.deepEqual(result, { ok: false, reason: 'invalid_input', retryable: false }, JSON.stringify(over).replace(TOKEN, 'T'));
        }
        assert.equal(calls.length, 0);
    });

    it('NEVER sends the token to a host that is not Meta\'s, even when Meta\'s own answer names one', async () => {
        onGet = async (url) => {
            if (url === `${BASE}/${MEDIA}`) return { data: { url: 'https://evil.example/steal?x=1', mime_type: 'audio/ogg', file_size: 10 } };
            throw new Error(`the token must not travel to ${url}`);
        };
        const result = await save();
        assert.equal(result.ok === false && result.reason, 'download_failed');
        assert.equal(result.ok === false && result.retryable, false, 'retrying cannot make that host Meta\'s');
        assert.deepEqual(calls.map((c) => c.url), [`${BASE}/${MEDIA}`], 'no request went to the other host');
    });

    it('reports a store that refused the bytes as retryable, with the detail scrubbed', async () => {
        arrange();
        putFails = new Error(`insert failed for ${SIGNED} using ${TOKEN}`);
        const result = await save();
        assert.equal(result.ok === false && result.reason, 'store_failed');
        assert.equal(result.ok === false && result.retryable, true);
        const text = JSON.stringify(result) + logged.join('\n');
        assert.ok(!text.includes(TOKEN));
        assert.ok(!text.includes('SIGNED-SECRET-HASH'));
    });
});

describe('saveInboundMedia: the token and the signed URL are never logged, returned or kept', () => {
    const SECRETS = [TOKEN, 'SIGNED-SECRET-HASH', 'SECOND-SIGNED-HASH', 'ext=1760000000', '?mid='];
    const assertClean = (text: string, label: string) => {
        for (const secret of SECRETS) assert.ok(!text.includes(secret), `${label} contains ${secret === TOKEN ? 'the token' : secret}`);
    };

    it('on success', async () => {
        arrange();
        const result = await save();
        assertClean(JSON.stringify(result) + logged.join('\n'), 'success');
        assert.ok(logged.some((line) => line.includes('whatsapp.media_saved')), 'something was logged, so the check above is not vacuous');
    });

    it('on every failure, even when the error\'s own message names the token and the full signed URL', async () => {
        const nasty = `connect ECONNRESET ${SIGNED} (Authorization: Bearer ${TOKEN}) token=${TOKEN}`;
        const failures: Array<[string, () => void]> = [
            ['lookup', () => { onGet = async () => { throw axiosFailure(undefined, nasty); }; }],
            ['lookup 404', () => { onGet = async () => { throw axiosFailure(404, nasty); }; }],
            ['lookup 190', () => { onGet = async () => { throw axiosFailure(400, nasty, { error: { message: nasty, code: 190 } }); }; }],
            ['download', () => arrange({ download: async () => { throw axiosFailure(undefined, nasty); } })],
            ['download 404 twice', () => arrange({ download: async () => { throw axiosFailure(404, nasty); } })],
            ['download 401', () => arrange({ download: async () => { throw axiosFailure(401, nasty); } })],
            ['too large', () => arrange({ download: async () => { throw axiosFailure(undefined, `maxContentLength size of 16777216 exceeded ${SIGNED}`); } })],
        ];
        for (const [label, setup] of failures) {
            logged = [];
            setup();
            const result = await save();
            assert.equal(result.ok, false, label);
            assertClean(JSON.stringify(result), `${label}: result`);
            assertClean(logged.join('\n'), `${label}: log`);
            assert.ok(logged.length > 0, `${label}: it logged, so the check is not vacuous`);
        }
    });

    it('safeDetail strips the token and reduces every URL to host and path', () => {
        const detail = safeDetail(new Error(`failed ${SIGNED} and ${SIGNED_2} with ${TOKEN}`), TOKEN);
        assertClean(detail, 'safeDetail');
        assert.match(detail, /https:\/\/lookaside\.fbsbx\.com\/whatsapp_business\/attachments\//);
        assert.match(detail, /\[token\]/);
    });
});
