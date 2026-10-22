/**
 * Signed direct uploads for ad media (A5): the refusals before anything is signed, the row that is written, and the ownership check
 * the creative upload leans on. The pool answers by SQL and Supabase's signing endpoint is stubbed: no database, no network.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setLogSink } from '../../utils/log.js';
import { setMediaStore, SupabaseStorageMediaStore, type MediaStore } from '../storage.js';
import { setStorageFetch } from '../supabaseStorage.js';
import { AdsError } from '../adBoosts.js';
import { AD_IMAGE_MAX_BYTES, AD_VIDEO_MAX_BYTES, assertOwnMedia, signAdUpload } from './adUploads.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MEDIA = 'e1111111-1111-4111-8111-111111111111';
const BASE = 'https://msg-response-auto.vercel.app';
const PROJECT = 'https://abcd1234.supabase.co';
const MB = 1024 * 1024;

let statements: { sql: string; params: any[] }[] = [];
let rows: Record<string, unknown>[] = [];
let signCalls = 0;
const original = { query: pool.query };
let previousStore: MediaStore | null = null;
let previousFetch: ReturnType<typeof setStorageFetch> = null;
let restoreSink: (() => void) | undefined;

const useSupabase = (): void => {
    previousFetch = setStorageFetch(async (input) => {
        signCalls += 1;
        const path = new URL(input).pathname.replace('/storage/v1', '');
        return new Response(JSON.stringify({ url: `${path}?token=signed-token-123` }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    setMediaStore(new SupabaseStorageMediaStore({ url: PROJECT, key: 'sb_secret_0123456789abcdefghijKLMNOP', source: { url: 'database', key: 'database' } }));
};

beforeEach(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    statements = [];
    rows = [];
    signCalls = 0;
    (pool as unknown as { query: unknown }).query = async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        statements.push({ sql: flat, params });
        return /^SELECT/.test(flat) ? { rows, rowCount: rows.length } : { rows: [], rowCount: 1 };
    };
    previousStore = setMediaStore(null);
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = original.query;
    setMediaStore(previousStore);
    setStorageFetch(previousFetch);
    previousFetch = null;
    restoreSink?.();
});

async function refusal(fn: () => Promise<unknown>): Promise<AdsError> {
    try {
        await fn();
    } catch (err) {
        assert.ok(err instanceof AdsError, `an AdsError, got ${String(err)}`);
        return err;
    }
    assert.fail('expected a refusal');
}

describe('signAdUpload — refusals, before anything is signed', () => {
    it('refuses a type Meta ads cannot use, naming the field', async () => {
        useSupabase();
        for (const mime of ['image/gif', 'image/webp', 'video/webm', 'application/pdf', undefined]) {
            const e = await refusal(() => signAdUpload(TENANT, { filename: 'a', mime, size: 1000 }, BASE));
            assert.equal(e.status, 400);
            assert.equal(e.code, 'INVALID');
            assert.equal(e.field, 'mime');
            assert.match(e.message, /JPEG|PNG|MP4/);
        }
        assert.equal(signCalls, 0);
        assert.ok(!statements.some((s) => /INSERT/.test(s.sql)));
    });

    it('refuses a missing, zero, fractional or non-numeric size', async () => {
        useSupabase();
        for (const size of [undefined, 0, -5, 1.5, '5000', Number.NaN]) {
            const e = await refusal(() => signAdUpload(TENANT, { filename: 'a.png', mime: 'image/png', size }, BASE));
            assert.equal(e.field, 'size', String(size));
            assert.equal(e.status, 400);
        }
    });

    it('holds an image to 30 MB and a video to 50 MB (Supabase free tier), each at the limit but not over it', async () => {
        useSupabase();
        assert.equal(AD_IMAGE_MAX_BYTES, 30 * MB);
        assert.equal(AD_VIDEO_MAX_BYTES, 50 * MB);
        const over = await refusal(() => signAdUpload(TENANT, { filename: 'a.jpg', mime: 'image/jpeg', size: 30 * MB + 1 }, BASE));
        assert.equal(over.field, 'size');
        assert.match(over.message, /30 ?MB/);
        const bigVideo = await refusal(() => signAdUpload(TENANT, { filename: 'a.mp4', mime: 'video/mp4', size: 50 * MB + 1 }, BASE));
        assert.equal(bigVideo.field, 'size');
        assert.match(bigVideo.message, /50 ?MB/);
        assert.equal(signCalls, 0);

        assert.equal((await signAdUpload(TENANT, { filename: 'a.jpg', mime: 'image/jpeg', size: 30 * MB }, BASE)).mediaId.length, 36);
        assert.equal((await signAdUpload(TENANT, { filename: 'a.mov', mime: 'video/quicktime', size: 50 * MB }, BASE)).mediaId.length, 36);
        // 40 MB is fine for a video and too much for a picture.
        await signAdUpload(TENANT, { filename: 'a.mp4', mime: 'video/mp4', size: 40 * MB }, BASE);
        const e = await refusal(() => signAdUpload(TENANT, { filename: 'a.png', mime: 'image/png', size: 40 * MB }, BASE));
        assert.equal(e.field, 'size');
    });

    it('409s when media is not on Supabase Storage', async () => {
        const e = await refusal(() => signAdUpload(TENANT, { filename: 'a.png', mime: 'image/png', size: 5000 }, BASE));
        assert.equal(e.status, 409);
        assert.equal(e.code, 'INVALID');
        assert.match(e.message, /Supabase Storage/);
        assert.ok(!statements.some((s) => /INSERT/.test(s.sql)));
    });
});

describe('signAdUpload — the answer and the row', () => {
    it('signs the tenant’s path, writes a public metadata-only row, and answers with our own URL and the PUT to make', async () => {
        useSupabase();
        const out = await signAdUpload(TENANT, { filename: 'poster.png', mime: 'image/png', size: 2 * MB }, BASE);
        assert.match(out.mediaId, /^[0-9a-f-]{36}$/);
        assert.equal(out.url, `${BASE}/api/uploads/${out.mediaId}`, 'the URL Meta fetches is ours, never the bucket’s');
        assert.deepEqual(out.upload, {
            method: 'PUT',
            url: `${PROJECT}/storage/v1/object/upload/sign/media/${TENANT}/${out.mediaId}.png?token=signed-token-123`,
            headers: { 'content-type': 'image/png', 'x-upsert': 'false', 'cache-control': 'max-age=31536000' },
        });
        assert.ok(Date.parse(out.expiresAt) > Date.now() + 60 * 60 * 1000, 'storage signs for two hours');
        assert.equal(signCalls, 1);

        const insert = statements.find((s) => /^INSERT INTO media_uploads/.test(s.sql));
        assert.ok(insert, 'one row');
        assert.doesNotMatch(insert.sql, /is_private/, 'public: Meta cURLs /api/uploads/<id>');
        assert.deepEqual(insert.params, [out.mediaId, TENANT, 'poster.png', 'image/png', `${TENANT}/${out.mediaId}.png`, 2 * MB]);
        assert.match(insert.sql, /data[\s\S]*NULL/, 'metadata only: no bytes in the row');
    });

    it('falls back to a plain filename when none is given', async () => {
        useSupabase();
        await signAdUpload(TENANT, { mime: 'video/mp4', size: 3 * MB }, BASE);
        const insert = statements.find((s) => /^INSERT INTO media_uploads/.test(s.sql));
        assert.equal(insert?.params[2], 'ad-upload');
    });
});

describe('assertOwnMedia', () => {
    it('answers the row’s type and size for the tenant’s own upload', async () => {
        rows = [{ mime_type: 'image/jpeg', size_bytes: '123456' }];
        assert.deepEqual(await assertOwnMedia(TENANT, MEDIA), { mime: 'image/jpeg', size: 123456 });
        const q = statements[0]!;
        assert.deepEqual(q.params, [MEDIA, TENANT], 'scoped to the tenant in the query itself');
    });

    it('is NOT_FOUND for an id that is not the tenant’s (another tenant’s looks the same), and for one that is not an id', async () => {
        for (const id of [MEDIA, 'not-a-uuid', '', undefined as unknown as string]) {
            const e = await refusal(() => assertOwnMedia(OTHER, id));
            assert.equal(e.status, 404);
            assert.equal(e.code as string, 'NOT_FOUND');
        }
    });
});
