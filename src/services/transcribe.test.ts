/**
 * `transcribeAudio`: a voice note to text, and the rule about WHO may hear it (docs/specs/001-whatsapp-agent T035, research R6/R4, FR-009,
 * FR-028/034).
 *
 * Settings come from the in-memory stand-in (`aiProviders/testDb.ts`), the provider is a `fetch` stand-in, and the media store is a fake
 * that honours `privateFor` the way the real one does. Pinned: which providers may serve (an allow-list: only those whose terms forbid
 * training, and the paid one only when the owner allowed paid AI), that anything else is `provider_unavailable` WITHOUT a call, the request
 * a voice note becomes, how every failure is typed, and that neither a key nor a transcript reaches a log.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../utils/log.js';
import { installAiDb, type AiDb } from './aiProviders/testDb.js';
import { FAKE_KEYS } from './aiProviders/testKeys.js';
import { hangingFetch, jsonResponse } from './llm/testFetch.js';
import type { FetchLike } from './llm/types.js';
import { setMediaStore, type MediaStore } from './storage.js';
import {
    baseMime, isTranscribeProvider, MAX_TRANSCRIBE_BYTES, TRANSCRIBE_DEFAULT_MODEL, TRANSCRIBE_PROVIDERS, transcribeAudio,
} from './transcribe.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const UPLOAD = '9b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const AUDIO = Buffer.from('OggS voice note');
const TRANSCRIPT = 'اهلا، عايز اعرف السعر لو سمحت';

const ENV_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY'] as const;
let db: AiDb;
let savedEnv: Record<string, string | undefined> = {};
let logged: string[];
let restoreSink: (() => void) | undefined;
let previousStore: MediaStore | null = null;
let storeReads: Array<{ id: string; privateFor: string | undefined }>;

interface Seen { url: string; headers: Record<string, string>; form: FormData }
let seen: Seen[];
let answer: () => Response | Promise<Response>;

const fetchImpl: FetchLike = async (url, init) => {
    seen.push({
        url,
        headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
        form: init.body as FormData,
    });
    return answer();
};

before(() => {
    savedEnv.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
});
after(() => {
    if (savedEnv.TOKEN_ENCRYPTION_KEY === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedEnv.TOKEN_ENCRYPTION_KEY;
});

beforeEach(() => {
    for (const name of ENV_NAMES) {
        savedEnv[name] = process.env[name];
        delete process.env[name];
    }
    db = installAiDb();
    seen = [];
    storeReads = [];
    logged = [];
    answer = () => jsonResponse(200, { text: TRANSCRIPT });
    const previous = setLogSink((_level, line) => { logged.push(line); });
    restoreSink = () => setLogSink(previous);
    previousStore = setMediaStore({
        async put() { return { id: UPLOAD }; },
        // The real store's rule: a private row is readable only with `privateFor` naming its tenant.
        async get(id, options) {
            storeReads.push({ id, privateFor: options?.privateFor });
            return id === UPLOAD && options?.privateFor === TENANT ? { id, mimeType: 'audio/ogg', data: AUDIO } : null;
        },
        async open() { return null; },
        async mimeTypes() { return new Map(); },
        publicUrl(id, origin) { return `${origin}/api/uploads/${id}`; },
    });
});

afterEach(() => {
    db.restore();
    restoreSink?.();
    setMediaStore(previousStore);
    for (const name of ENV_NAMES) {
        if (savedEnv[name] === undefined) delete process.env[name];
        else process.env[name] = savedEnv[name];
    }
});

const withKey = (...providers: Array<keyof typeof FAKE_KEYS>) => {
    for (const p of providers) db.setSetting(`ai.providers.${p}.api_key`, FAKE_KEYS[p], true);
};
const gemini = () => db.setSetting('gemini.api_key', FAKE_KEYS.gemini, true);
const note = (over: Record<string, unknown> = {}) => transcribeAudio({ bytes: AUDIO, mime: 'audio/ogg; codecs=opus', fetchImpl, ...over } as Parameters<typeof transcribeAudio>[0]);

describe('transcribeAudio: the request a voice note becomes', () => {
    it('sends audio/ogg to Groq\'s whisper-large-v3-turbo with the Arabic hint, and returns the text', async () => {
        withKey('groq');

        const result = await note();

        assert.deepEqual(result, { ok: true, text: TRANSCRIPT, provider: 'groq', model: 'whisper-large-v3-turbo' });
        assert.equal(seen.length, 1);
        assert.equal(seen[0]!.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
        assert.equal(seen[0]!.headers.authorization, `Bearer ${FAKE_KEYS.groq}`);
        assert.equal(seen[0]!.form.get('model'), 'whisper-large-v3-turbo');
        assert.equal(seen[0]!.form.get('language'), 'ar');
        assert.equal(seen[0]!.form.get('response_format'), 'json');
        const file = seen[0]!.form.get('file') as File;
        assert.equal(file.name, 'voice.ogg');
        assert.equal(file.type, 'audio/ogg', 'the codecs parameter is dropped');
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), AUDIO);
    });

    it('takes a hint other than Arabic, and a model the caller names', async () => {
        withKey('groq');
        await note({ languageHint: 'en', model: 'whisper-large-v3' });
        assert.equal(seen[0]!.form.get('language'), 'en');
        assert.equal(seen[0]!.form.get('model'), 'whisper-large-v3');
    });

    it('reads an upload through the media store, scoped to the tenant: privateFor, never the public read', async () => {
        withKey('groq');
        const result = await transcribeAudio({ creatorId: TENANT, uploadId: UPLOAD, mime: 'audio/ogg', fetchImpl });
        assert.equal(result.ok, true);
        assert.deepEqual(storeReads, [{ id: UPLOAD, privateFor: TENANT }]);
    });

    it('is upload_missing for a voice note of another tenant, or one that does not exist, and never calls the provider', async () => {
        withKey('groq');
        assert.deepEqual(await transcribeAudio({ creatorId: OTHER_TENANT, uploadId: UPLOAD, mime: 'audio/ogg', fetchImpl }), { ok: false, reason: 'upload_missing' });
        assert.deepEqual(await transcribeAudio({ creatorId: TENANT, uploadId: '8b8a7a0e-3c1f-4f7e-9d0a-1234567890ab', mime: 'audio/ogg', fetchImpl }), { ok: false, reason: 'upload_missing' });
        assert.equal(seen.length, 0);
    });

    it('the formats it passes on are the ones Groq lists; aac and amr (which WhatsApp also sends) are refused without a call', async () => {
        withKey('groq');
        for (const mime of ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'AUDIO/OGG; codecs=opus', 'audio/webm', 'audio/wav']) {
            assert.equal((await note({ mime })).ok, true, mime);
        }
        const before = seen.length;
        for (const mime of ['audio/aac', 'audio/amr', 'image/png', 'text/plain', '', 'application/octet-stream']) {
            assert.deepEqual(await note({ mime }), { ok: false, reason: 'unsupported_media' }, mime);
        }
        assert.equal(seen.length, before, 'no call for a format the provider does not take');
        assert.equal(baseMime('audio/ogg; codecs=opus'), 'audio/ogg');
    });

    it('is too_large above 16 MB and empty for no bytes, both without a call', async () => {
        withKey('groq');
        assert.deepEqual(await note({ bytes: Buffer.alloc(MAX_TRANSCRIBE_BYTES + 1) }), { ok: false, reason: 'too_large' });
        assert.deepEqual(await note({ bytes: Buffer.alloc(0) }), { ok: false, reason: 'empty' });
        assert.equal(seen.length, 0);
    });
});

describe('transcribeAudio: only a provider whose terms forbid training may hear a customer', () => {
    it('the allow-list is groq and openai, and nothing else', () => {
        assert.deepEqual([...TRANSCRIBE_PROVIDERS], ['groq', 'openai']);
        for (const id of ['groq', 'openai']) assert.equal(isTranscribeProvider(id), true, id);
        for (const id of ['gemini', 'openrouter', 'custom', 'anthropic', '', 'GROQ', null, undefined]) assert.equal(isTranscribeProvider(id), false, String(id));
        assert.equal(TRANSCRIBE_DEFAULT_MODEL.groq, 'whisper-large-v3-turbo');
    });

    it('is provider_unavailable, WITHOUT a call, when the only keys are for providers that may train or are not on the list', async () => {
        gemini();
        withKey('openrouter', 'anthropic');
        db.setSetting('ai.providers.custom.api_key', FAKE_KEYS.custom, true);
        db.setSetting('ai.providers', JSON.stringify({ custom: { baseUrl: 'https://speech.example.com/v1' } }));

        assert.deepEqual(await note(), { ok: false, reason: 'provider_unavailable' });
        assert.deepEqual(await note({ allowPaid: true }), { ok: false, reason: 'provider_unavailable' });
        assert.equal(seen.length, 0, 'nothing was sent to anyone');
    });

    it('is provider_unavailable with no key at all, and when the provider is switched off', async () => {
        assert.deepEqual(await note(), { ok: false, reason: 'provider_unavailable' });
        withKey('groq');
        db.setSetting('ai.providers', JSON.stringify({ groq: { enabled: false } }));
        assert.deepEqual(await note(), { ok: false, reason: 'provider_unavailable' });
        assert.equal(seen.length, 0);
    });

    it('uses Groq even when Gemini has a key (Gemini\'s free tier may train; it is never a fall-through)', async () => {
        gemini();
        withKey('groq');
        const result = await note();
        assert.equal(result.ok && result.provider, 'groq');
        assert.equal(seen.length, 1);
        assert.ok(seen[0]!.url.startsWith('https://api.groq.com/'));
    });

    it('does not fall through to Gemini or another provider when Groq fails', async () => {
        gemini();
        withKey('groq', 'openrouter');
        answer = () => jsonResponse(500, { error: { message: 'boom' } });
        assert.deepEqual(await note(), { ok: false, reason: 'failed' });
        assert.equal(seen.length, 1, 'one call, to Groq, and no second provider');
    });

    it('OpenAI is paid: it serves only when the owner allowed paid AI, and Groq (free) still goes first', async () => {
        withKey('openai');
        assert.deepEqual(await note(), { ok: false, reason: 'provider_unavailable' }, 'paid AI is off by default');
        assert.equal(seen.length, 0);

        const result = await note({ allowPaid: true });
        assert.deepEqual(result, { ok: true, text: TRANSCRIPT, provider: 'openai', model: 'whisper-1' });
        assert.equal(seen[0]!.url, 'https://api.openai.com/v1/audio/transcriptions');
        assert.equal(seen[0]!.headers.authorization, `Bearer ${FAKE_KEYS.openai}`);

        seen = [];
        withKey('groq');
        const both = await note({ allowPaid: true });
        assert.equal(both.ok && both.provider, 'groq');
        assert.ok(seen[0]!.url.startsWith('https://api.groq.com/'));
    });

    it('finds the key in the environment when none is saved', async () => {
        process.env.GROQ_API_KEY = FAKE_KEYS.groq;
        assert.equal((await note()).ok, true);
        assert.equal(seen[0]!.headers.authorization, `Bearer ${FAKE_KEYS.groq}`);
    });
});

describe('transcribeAudio: every failure is a typed value, never a throw', () => {
    beforeEach(() => withKey('groq'));

    it('429 is rate_limited, 401 is provider_unavailable (a dead key), 5xx and nonsense are failed', async () => {
        answer = () => jsonResponse(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '3' });
        assert.deepEqual(await note(), { ok: false, reason: 'rate_limited' });
        answer = () => jsonResponse(401, { error: { message: 'Invalid API Key' } });
        assert.deepEqual(await note(), { ok: false, reason: 'provider_unavailable' });
        answer = () => jsonResponse(502, 'bad gateway');
        assert.deepEqual(await note(), { ok: false, reason: 'failed' });
        answer = () => new Response('<html>', { status: 200 });
        assert.deepEqual(await note(), { ok: false, reason: 'failed' });
    });

    it('a provider that never answers is a timeout, at the deadline', async () => {
        const result = await transcribeAudio({ bytes: AUDIO, mime: 'audio/ogg', fetchImpl: hangingFetch, timeoutMs: 30 });
        assert.deepEqual(result, { ok: false, reason: 'timeout' });
    });

    it('silence is empty: the provider answered and heard nothing', async () => {
        answer = () => jsonResponse(200, { text: '   ' });
        assert.deepEqual(await note(), { ok: false, reason: 'empty' });
    });

    it('does not throw whatever the fetch does, or the store, or the settings', async () => {
        const boom: FetchLike = async () => { throw new RangeError('anything at all'); };
        assert.deepEqual(await transcribeAudio({ bytes: AUDIO, mime: 'audio/ogg', fetchImpl: boom }), { ok: false, reason: 'timeout' });

        setMediaStore({
            async put() { return { id: UPLOAD }; },
            async get() { throw new Error('storage exploded'); },
            async open() { return null; },
            async mimeTypes() { return new Map(); },
            publicUrl(id, origin) { return `${origin}/${id}`; },
        });
        assert.deepEqual(await transcribeAudio({ creatorId: TENANT, uploadId: UPLOAD, mime: 'audio/ogg', fetchImpl }), { ok: false, reason: 'upload_missing' });

        db.failOn(/app_settings/, new Error('connection terminated unexpectedly'), 5);
        assert.deepEqual(await note(), { ok: false, reason: 'provider_unavailable' });
    });
});

describe('transcribeAudio: what reaches a log', () => {
    it('neither the key nor a word of the transcript, on success or failure; sizes and the provider are enough', async () => {
        withKey('groq');
        assert.equal((await note()).ok, true);
        answer = () => jsonResponse(401, { error: { message: `Incorrect API key provided: ${FAKE_KEYS.groq}` } });
        assert.equal((await note()).ok, false);

        const text = logged.join('\n');
        assert.ok(logged.length >= 2, 'it logged, so this check is not vacuous');
        assert.ok(!text.includes(FAKE_KEYS.groq), 'no key');
        assert.ok(!text.includes(FAKE_KEYS.groq.slice(8, -4)), 'no part of a key');
        assert.ok(!text.includes(TRANSCRIPT) && !text.includes('سعر'), 'no transcript');
        assert.match(text, /transcribe\.done/);
        assert.match(text, /"text_chars":/);
        assert.match(text, /transcribe\.failed/);
    });
});
