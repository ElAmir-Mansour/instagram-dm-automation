/**
 * Signed uploads (MONTEUR.md §4; illustrated explainers T051): a file too big for Vercel's 4.5 MB request goes straight to Supabase Storage through
 * a signed URL, and the row that makes it an ordinary `/api/uploads/<id>` is written here, metadata only.
 *
 *   - the Mac worker may now also sign `audio/mp4` (the voiced narration of an explainer, an m4a);
 *   - `signExplainerUpload` is what the dashboard's owner-only route calls for a music track or a character's reference picture: a type per purpose, 25 MB.
 *
 * The existing worker route is covered, with its reel and its refusals, in `routes/studio.test.ts`; this file covers what T051 adds, and the
 * checks the two share. Storage answers through an injected fetch: nothing here reaches Supabase.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { setMediaStore, SupabaseStorageMediaStore, type MediaStore } from '../storage.js';
import { StudioError } from '../studio/common.js';
import { setStorageFetch } from '../supabaseStorage.js';
import { installFakeDb, type FakeDb } from './testDb.js';
import {
    EXPLAINER_UPLOAD_TYPES, MAX_EXPLAINER_UPLOAD_BYTES, MAX_SIGNED_UPLOAD_BYTES, parseSignRequest, SIGNED_UPLOAD_TYPES, signExplainerUpload, signWorkerUpload,
} from './uploads.js';

const TENANT = '22222222-2222-4222-8222-222222222222';
const PROJECT = 'https://abcd1234.supabase.co';
const SECRET = 'sb_secret_0123456789abcdefghijKLMNOP';
const BASE = 'https://app.example.test';
const MB = 1024 * 1024;

let db: FakeDb;
let previousStore: MediaStore | null;
let previousFetch: ReturnType<typeof setStorageFetch> = null;
let signCalls: { method: string; url: string; headers: Record<string, string> }[] = [];
let storageAnswer: (path: string) => Response;
let logs: { event: string; fields: Record<string, unknown> }[] = [];
let restoreSink: (() => void) | undefined;

before(() => {
    const previous = setLogSink((_threshold, line) => { const { ts: _ts, level: _level, event, ...fields } = JSON.parse(line); logs.push({ event, fields }); });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    logs = [];
    signCalls = [];
    storageAnswer = (path) => new Response(JSON.stringify({ url: `${path}?token=signed-token-123` }), { status: 200, headers: { 'content-type': 'application/json' } });
    db = installFakeDb();
    previousFetch = setStorageFetch(async (input, init = {}) => {
        const headers: Record<string, string> = {};
        new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
        signCalls.push({ method: String(init.method), url: input, headers });
        return storageAnswer(new URL(input).pathname.replace('/storage/v1', ''));
    });
    previousStore = setMediaStore(new SupabaseStorageMediaStore({ url: PROJECT, key: SECRET, source: { url: 'database', key: 'database' } }));
});

afterEach(() => {
    setStorageFetch(previousFetch);
    setMediaStore(previousStore);
    db.restore();
});

const base = async (): Promise<string | null> => BASE;
const rows = () => db.ran(/^INSERT INTO media_uploads/);
const refused = (status: number, text?: RegExp) => (err: unknown) => {
    assert.ok(err instanceof StudioError, `a StudioError, not ${String(err)}`);
    assert.equal(err.status, status);
    if (text) assert.match(err.message + (err.problems ?? []).join(' '), text);
    return true;
};

describe('the Mac worker’s signed uploads', () => {
    it('may sign an m4a (audio/mp4) as well as a reel, its cover and a GIF', () => {
        assert.deepEqual([...SIGNED_UPLOAD_TYPES], ['video/mp4', 'image/jpeg', 'image/gif', 'audio/mp4']);
        assert.deepEqual(parseSignRequest({ filename: 'voice.m4a', mime_type: 'audio/mp4', size_bytes: 900_000 }), { filename: 'voice.m4a', mimeType: 'audio/mp4', sizeBytes: 900_000 });
    });

    it('still refuses every other audio type, and the types it never took', () => {
        for (const mime_type of ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac', 'image/png', 'video/quicktime', 'application/pdf']) {
            assert.throws(() => parseSignRequest({ filename: 'x', mime_type, size_bytes: 1000 }), refused(400, /mime_type must be one of video\/mp4, image\/jpeg, image\/gif, audio\/mp4/), mime_type);
        }
    });

    it('holds the same 100 MB ceiling for audio as for a reel', () => {
        assert.throws(() => parseSignRequest({ filename: 'x', mime_type: 'audio/mp4', size_bytes: MAX_SIGNED_UPLOAD_BYTES + 1 }), refused(400, /100MB/));
        assert.doesNotThrow(() => parseSignRequest({ filename: 'x', mime_type: 'audio/mp4', size_bytes: MAX_SIGNED_UPLOAD_BYTES }));
    });

    it('signs an m4a: the path ends in .m4a, the row holds metadata only, and the answer is the one a reel gets', async () => {
        const answer = await signWorkerUpload(TENANT, { filename: 'narration.m4a', mime_type: 'audio/mp4', size_bytes: 1_200_000 }, base);
        assert.match(answer.id, /^[0-9a-f-]{36}$/);
        assert.equal(answer.url, `${BASE}/api/uploads/${answer.id}`, 'the URL the render fetches is ours, never the bucket’s');
        assert.deepEqual(answer.upload, {
            method: 'PUT',
            url: `${PROJECT}/storage/v1/object/upload/sign/media/${TENANT}/${answer.id}.m4a?token=signed-token-123`,
            headers: { 'content-type': 'audio/mp4', 'x-upsert': 'false', 'cache-control': 'max-age=31536000' },
        });
        const [row] = rows();
        assert.match(row!.sql, /VALUES \(\$1, \$2, \$3, \$4, NULL, \$5, \$6\)/, 'no bytes in Postgres');
        assert.deepEqual(row!.params, [answer.id, TENANT, 'narration.m4a', 'audio/mp4', `${TENANT}/${answer.id}.m4a`, 1_200_000]);
    });
});

describe('signExplainerUpload — what the owner may upload', () => {
    const ask = (purpose: unknown, mime: unknown, size: unknown, publicBase: Parameters<typeof signExplainerUpload>[2] = base) =>
        signExplainerUpload(TENANT, { purpose, mime, size } as never, publicBase);

    it('allows audio/mpeg, audio/mp4 and audio/wav for music, and image/png and image/jpeg for a reference, and no other pairing', () => {
        assert.deepEqual({ ...EXPLAINER_UPLOAD_TYPES }, { music: ['audio/mpeg', 'audio/mp4', 'audio/wav'], reference: ['image/png', 'image/jpeg'] });
        assert.equal(MAX_EXPLAINER_UPLOAD_BYTES, 25 * MB);
    });

    it('signs each allowed pair, and answers { upload_url, media_id, url } and nothing else', async () => {
        for (const [purpose, mime] of [['music', 'audio/mpeg'], ['music', 'audio/mp4'], ['music', 'audio/wav'], ['reference', 'image/png'], ['reference', 'image/jpeg']] as const) {
            const answer = await ask(purpose, mime, 3 * MB);
            assert.deepEqual(Object.keys(answer).sort(), ['media_id', 'upload_url', 'url'], `${purpose} ${mime}`);
            assert.match(answer.media_id, /^[0-9a-f-]{36}$/);
            assert.equal(answer.url, `${BASE}/api/uploads/${answer.media_id}`);
            assert.ok(answer.upload_url.startsWith(`${PROJECT}/storage/v1/object/upload/sign/media/${TENANT}/${answer.media_id}`), answer.upload_url);
            assert.ok(answer.upload_url.endsWith('?token=signed-token-123'));
        }
        assert.equal(rows().length, 5);
    });

    it('names the file by its type in the bucket, and the row for what it is', async () => {
        const mp3 = await ask('music', 'audio/mpeg', 4 * MB);
        assert.equal(mp3.upload_url, `${PROJECT}/storage/v1/object/upload/sign/media/${TENANT}/${mp3.media_id}.mp3?token=signed-token-123`);
        const png = await ask('reference', 'image/png', 200_000);
        assert.equal(png.upload_url, `${PROJECT}/storage/v1/object/upload/sign/media/${TENANT}/${png.media_id}.png?token=signed-token-123`);
        const [first, second] = rows();
        assert.deepEqual(first!.params, [mp3.media_id, TENANT, 'explainer-music', 'audio/mpeg', `${TENANT}/${mp3.media_id}.mp3`, 4 * MB]);
        assert.deepEqual(second!.params, [png.media_id, TENANT, 'explainer-reference', 'image/png', `${TENANT}/${png.media_id}.png`, 200_000]);
        assert.match(first!.sql, /VALUES \(\$1, \$2, \$3, \$4, NULL, \$5, \$6\)/, 'no bytes in Postgres');
    });

    it('asks Storage to sign the path with the secret key, once, and sends no bytes', async () => {
        await ask('music', 'audio/mpeg', MB);
        assert.equal(signCalls.length, 1);
        assert.equal(signCalls[0]!.method, 'POST');
        assert.equal(signCalls[0]!.headers.apikey, SECRET);
    });

    it('gives each upload its own id', async () => {
        const [a, b] = [await ask('music', 'audio/mpeg', MB), await ask('music', 'audio/mpeg', MB)];
        assert.notEqual(a.media_id, b.media_id);
    });

    it('refuses a type that does not go with the purpose: a picture as music, a track as a reference', async () => {
        for (const [purpose, mime] of [['music', 'image/png'], ['music', 'image/jpeg'], ['reference', 'audio/mpeg'], ['reference', 'audio/mp4'], ['reference', 'audio/wav']] as const) {
            await assert.rejects(ask(purpose, mime, MB), refused(400, new RegExp(`mime must be one of .* for ${purpose}`)), `${purpose} ${mime}`);
        }
        assert.equal(rows().length + signCalls.length, 0);
    });

    it('refuses the types nobody uploads here, and a purpose that is not one', async () => {
        for (const mime of ['audio/ogg', 'audio/aac', 'video/mp4', 'image/gif', 'image/webp', 'application/pdf', 'text/html', '', null, 42]) {
            await assert.rejects(ask('music', mime, MB), refused(400, /mime/), String(mime));
            await assert.rejects(ask('reference', mime, MB), refused(400, /mime/), String(mime));
        }
        for (const purpose of ['video', 'avatar', '', null, undefined, 7]) {
            await assert.rejects(ask(purpose, 'audio/mpeg', MB), refused(400, /purpose/), String(purpose));
        }
        assert.equal(rows().length + signCalls.length, 0);
    });

    it('takes up to 25 MB and refuses more, and a size that is not a whole positive number of bytes', async () => {
        assert.equal((await ask('music', 'audio/wav', 25 * MB)).media_id.length, 36);
        await assert.rejects(ask('music', 'audio/wav', 25 * MB + 1), refused(400, /25MB/));
        for (const size of [0, -1, 1.5, '5000', null, undefined, Number.NaN, Infinity]) {
            await assert.rejects(ask('music', 'audio/wav', size), refused(400, /size/), String(size));
        }
    });

    it('says every problem at once, with 400 and the list', async () => {
        await assert.rejects(ask('avatar', 'text/html', -5), (err: unknown) => {
            assert.ok(err instanceof StudioError);
            assert.equal(err.status, 400);
            assert.equal(err.problems?.length, 3);
            assert.match(err.message, /3 problems/);
            return true;
        });
    });

    it('is refused before anything else is asked: no storage lookup, no signature, no row', async () => {
        setMediaStore(null);
        await assert.rejects(ask('music', 'image/png', MB), refused(400));
        assert.equal(rows().length + signCalls.length, 0);
    });
});

describe('signExplainerUpload — where it signs', () => {
    const ask = (publicBase: Parameters<typeof signExplainerUpload>[2]) => signExplainerUpload(TENANT, { purpose: 'music', mime: 'audio/mpeg', size: MB }, publicBase);

    it('is 409 when media does not go to Supabase Storage: there is nothing to sign against, and no row is written', async () => {
        setMediaStore({} as MediaStore);
        await assert.rejects(ask(base), refused(409, /Supabase Storage/));
        assert.equal(rows().length + signCalls.length, 0);
    });

    it('is 500 when the app has no public address to build the URL on', async () => {
        await assert.rejects(ask(async () => null), refused(500, /No public address/));
        await assert.rejects(ask(null), refused(500, /No public address/));
        assert.equal(rows().length, 0, 'signed first, written after: a refusal leaves no row');
    });

    it('takes the public address as a function, as the worker route does, or as the address itself', async () => {
        assert.equal((await ask(base)).url.startsWith(`${BASE}/api/uploads/`), true);
        assert.equal((await ask(BASE)).url.startsWith(`${BASE}/api/uploads/`), true);
    });

    it('is 502, with Storage’s own words, when Storage refuses to sign, and writes no row', async () => {
        storageAnswer = () => new Response(JSON.stringify({ statusCode: '403', error: 'Unauthorized', message: 'The secret key was refused' }), { status: 400, headers: { 'content-type': 'application/json' } });
        await assert.rejects(ask(base), refused(502, /secret key was refused/));
        assert.equal(rows().length, 0);
    });

    it('logs that it signed, with the purpose and the size, and nothing of the signed address', async () => {
        const answer = await ask(base);
        const signed = logs.find((entry) => entry.event === 'explainer.upload_signed');
        assert.ok(signed);
        assert.deepEqual(signed.fields, { media_id: answer.media_id, purpose: 'music', bytes: MB, mime_type: 'audio/mpeg' });
        assert.equal(JSON.stringify(logs).includes('signed-token-123'), false);
    });
});
