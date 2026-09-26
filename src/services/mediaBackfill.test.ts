/**
 * scripts/migrate-media-to-storage.mjs — moving legacy BYTEA rows into Supabase Storage.
 *
 * The script clears `data` on production rows, which is the one irreversible thing in this
 * migration, so the rule that matters most is pinned hardest: a row is changed only after its
 * copy has been downloaded back and matched byte for byte, and in one statement that records the
 * copy and clears the bytes together.
 *
 * The script is plain ESM and mirrors src/services/supabaseStorage.ts rather than importing it.
 * The parity tests below are what keep that duplication honest: same headers for both key
 * formats, same object paths, same origin rule.
 *
 * Imported, never run: it only touches a database when executed directly.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { encryptSecret } from '../config/crypto.js';
import { normaliseOrigin } from './appSettings.js';
import { MEDIA_BUCKET, objectPathFor, SERVER_USER_AGENT, storageAuthHeaders } from './supabaseStorage.js';

type Json = Record<string, any>;
const script: Json = await import(new URL('../../scripts/migrate-media-to-storage.mjs', import.meta.url).href);

const CREATOR = '11111111-1111-4111-8111-111111111111';
const ID = '0b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const PATH = `${CREATOR}/${ID}.mp4`;
const SECRET = 'sb_secret_0123456789abcdefghijKLMNOP';
const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const LEGACY = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ role: 'service_role' })}.c2ln`;
const BYTES = Buffer.from('the reel, as Postgres holds it');

describe('the backfill says what the app says', () => {
    it('sends each key format in the same headers as the app', () => {
        for (const key of [SECRET, LEGACY]) {
            assert.deepEqual(script.storageHeaders(key), storageAuthHeaders(key), key.slice(0, 10));
        }
        assert.equal(script.storageHeaders(SECRET).Authorization, undefined, 'a secret key is never a Bearer token');
        assert.equal(script.SERVER_USER_AGENT, SERVER_USER_AGENT);
        assert.equal(script.MEDIA_BUCKET, MEDIA_BUCKET);
    });

    it('names objects exactly as the app does', () => {
        for (const [creator, mime] of [
            [CREATOR, 'video/mp4'], [CREATOR, 'image/jpeg'], [CREATOR, 'image/png'], [CREATOR, 'image/webp'],
            [CREATOR, 'video/quicktime'], [CREATOR, 'text/html'], [null, 'image/jpeg'],
        ] as const) {
            assert.equal(script.objectPathFor(creator, ID, mime), objectPathFor(creator, ID, mime), `${creator} ${mime}`);
        }
        assert.throws(() => script.objectPathFor(CREATOR, '../x', 'image/jpeg'));
    });

    it('reads the project URL by the same rule', () => {
        for (const input of ['https://abcd1234.supabase.co/', ' https://abcd1234.supabase.co/rest/v1 ', 'http://abcd1234.supabase.co', 'http://localhost:54321', 'nonsense']) {
            assert.equal(script.normaliseOrigin(input), normaliseOrigin(input), input);
        }
    });
});

describe('verifyCopy — the check that decides whether Postgres may let go of the bytes', () => {
    const storageHolding = (copy: Buffer | null) => ({ download: async () => copy });

    it('passes a copy that matches byte for byte, and names its sha256', async () => {
        const result = await script.verifyCopy(storageHolding(Buffer.from(BYTES)), PATH, BYTES);
        assert.deepEqual(result, { ok: true, sha256: createHash('sha256').update(BYTES).digest('hex') });
    });

    it('fails a copy with one byte changed, a short copy, and a missing one', async () => {
        const flipped = Buffer.from(BYTES);
        flipped[5] = flipped[5]! ^ 0xff;
        const cases: Array<[Buffer | null, RegExp]> = [
            [flipped, /sha256/],
            [BYTES.subarray(0, BYTES.length - 1), /bytes came back/],
            [null, /not in the bucket/],
        ];
        for (const [copy, reason] of cases) {
            const result = await script.verifyCopy(storageHolding(copy), PATH, BYTES);
            assert.equal(result.ok, false);
            assert.match(result.reason, reason);
        }
    });
});

describe('migrateRow', () => {
    interface Step { op: string; detail?: unknown }
    let steps: Step[];

    /** A database with one row, recording every statement in order. */
    function database(options: { updateCount?: number; afterUpdate?: { storage_path: string } | null } = {}) {
        return {
            async query(sql: string, params: unknown[] = []) {
                const flat = sql.replace(/\s+/g, ' ').trim();
                if (/^SELECT data FROM media_uploads/.test(flat)) {
                    steps.push({ op: 'read' });
                    return { rows: [{ data: Buffer.from(BYTES) }], rowCount: 1 };
                }
                if (/^UPDATE media_uploads/.test(flat)) {
                    steps.push({ op: 'update', detail: { sql: flat, params } });
                    return { rows: [], rowCount: options.updateCount ?? 1 };
                }
                if (/^SELECT storage_path FROM media_uploads/.test(flat)) {
                    steps.push({ op: 'recheck' });
                    return { rows: options.afterUpdate ? [options.afterUpdate] : [], rowCount: options.afterUpdate ? 1 : 0 };
                }
                throw new Error(`unexpected SQL: ${flat}`);
            },
        };
    }

    function storage(copy: (sent: Buffer) => Buffer | null = (sent) => Buffer.from(sent)) {
        let held: Buffer | null = null;
        return {
            async upload(path: string, data: Buffer, type: string) { steps.push({ op: 'upload', detail: { path, type } }); held = data; },
            async download(path: string) { steps.push({ op: 'download', detail: path }); return held ? copy(held) : null; },
            async remove(paths: string[]) { steps.push({ op: 'remove', detail: paths }); },
        };
    }

    const row = { id: ID, creator_id: CREATOR, mime_type: 'video/mp4', storage_path: null };

    beforeEach(() => { steps = []; });

    it('uploads, reads it back, and only then records the copy and clears the bytes, in one statement', async () => {
        const outcome = await script.migrateRow({ db: database(), storage: storage() }, row);

        assert.deepEqual(steps.map((s) => s.op), ['read', 'upload', 'download', 'update']);
        assert.deepEqual(steps[1]!.detail, { path: PATH, type: 'video/mp4' });
        const update = steps[3]!.detail as { sql: string; params: unknown[] };
        assert.match(update.sql, /SET storage_path = \$2, size_bytes = \$3, data = NULL/);
        assert.match(update.sql, /WHERE id = \$1 AND data IS NOT NULL/);
        assert.deepEqual(update.params, [ID, PATH, BYTES.length]);
        assert.equal(outcome.status, 'moved');
        assert.equal(outcome.sha256, createHash('sha256').update(BYTES).digest('hex'));
    });

    it('never touches the row when the copy does not match', async () => {
        const corrupt = storage((sent) => Buffer.concat([sent.subarray(0, -1), Buffer.from('!')]));

        await assert.rejects(script.migrateRow({ db: database(), storage: corrupt }, row), /did not verify.*stay in Postgres/);
        assert.deepEqual(steps.map((s) => s.op), ['read', 'upload', 'download'], 'no UPDATE: the bytes stay');
    });

    it('never touches the row when the upload is refused', async () => {
        const refusing = {
            ...storage(),
            async upload() { steps.push({ op: 'upload' }); throw new Error('Supabase Storage refused to upload the file: The object exceeded the maximum allowed size'); },
        };
        await assert.rejects(script.migrateRow({ db: database(), storage: refusing }, row), /maximum allowed size/);
        assert.ok(!steps.some((s) => s.op === 'update'));
    });

    it('finishes a row left half-way, at the path it already names', async () => {
        const outcome = await script.migrateRow({ db: database(), storage: storage() }, { ...row, storage_path: `${CREATOR}/elsewhere.mp4` });
        assert.equal(outcome.path, `${CREATOR}/elsewhere.mp4`);
    });

    it('takes the object back out when the row was deleted while it uploaded', async () => {
        const outcome = await script.migrateRow({ db: database({ updateCount: 0, afterUpdate: null }), storage: storage() }, row);
        assert.equal(outcome.status, 'gone');
        assert.deepEqual(steps.at(-1), { op: 'remove', detail: [PATH] });
    });

    it('keeps the object when another run finished the row first', async () => {
        const outcome = await script.migrateRow({ db: database({ updateCount: 0, afterUpdate: { storage_path: PATH } }), storage: storage() }, row);
        assert.equal(outcome.status, 'gone');
        assert.ok(!steps.some((s) => s.op === 'remove'), 'that object is the one the row now names');
    });
});

describe('storageClient on the wire', () => {
    it('uploads with upsert (a re-run is harmless) and downloads from the authenticated endpoint, in each key\'s headers', async () => {
        for (const key of [SECRET, LEGACY]) {
            const seen: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
            const client = script.storageClient({
                url: 'https://abcd1234.supabase.co',
                key,
                fetchImpl: async (url: string, init: RequestInit) => {
                    const headers: Record<string, string> = {};
                    new Headers(init.headers as Record<string, string>).forEach((v, k) => { headers[k] = v; });
                    seen.push({ method: String(init.method), url, headers });
                    return init.method === 'POST' ? new Response('{"Key":"x"}', { status: 200 }) : new Response(BYTES, { status: 200 });
                },
            });

            await client.upload(PATH, BYTES, 'video/mp4');
            assert.deepEqual(await client.download(PATH), BYTES);

            assert.equal(seen[0]!.url, `https://abcd1234.supabase.co/storage/v1/object/media/${PATH}`);
            assert.equal(seen[0]!.headers['x-upsert'], 'true');
            assert.equal(seen[1]!.url, `https://abcd1234.supabase.co/storage/v1/object/authenticated/media/${PATH}`);
            for (const call of seen) {
                assert.equal(call.headers.apikey, key);
                assert.equal(call.headers.authorization, key === LEGACY ? `Bearer ${LEGACY}` : undefined);
                assert.equal(call.headers['user-agent'], SERVER_USER_AGENT);
            }
        }
    });
});

describe('resolveStorageConfig — the app\'s own config', () => {
    let saved: Record<string, string | undefined>;
    beforeEach(() => {
        saved = { enc: process.env.TOKEN_ENCRYPTION_KEY };
        process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    });
    afterEach(() => {
        if (saved.enc === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
        else process.env.TOKEN_ENCRYPTION_KEY = saved.enc;
    });

    const holding = (rows: Array<{ key: string; value: string; is_secret: boolean }>) => ({
        async query() { return { rows, rowCount: rows.length }; },
    });

    it('takes Settings first, decrypting the key, then the environment', async () => {
        const env = { SUPABASE_URL: 'https://env5678.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_env_0123456789abcd' };
        const db = holding([
            { key: 'storage.supabase_url', value: 'https://saved1234.supabase.co', is_secret: false },
            { key: 'storage.supabase_service_key', value: encryptSecret(SECRET), is_secret: true },
        ]);
        const config = await script.resolveStorageConfig(db, env);
        assert.equal(config.url, 'https://saved1234.supabase.co');
        assert.equal(config.key, SECRET);

        const fallback = await script.resolveStorageConfig(holding([]), env);
        assert.equal(fallback.url, 'https://env5678.supabase.co');
        assert.equal(fallback.key, 'sb_secret_env_0123456789abcd');

        assert.equal(await script.resolveStorageConfig(holding([]), {}), null);
    });

    it('treats a database with no app_settings table as nothing saved', async () => {
        const db = { async query() { throw Object.assign(new Error('relation "app_settings" does not exist'), { code: '42P01' }); } };
        const config = await script.resolveStorageConfig(db, { SUPABASE_URL: 'https://env5678.supabase.co', SUPABASE_SERVICE_ROLE_KEY: SECRET });
        assert.equal(config.url, 'https://env5678.supabase.co');
    });
});
