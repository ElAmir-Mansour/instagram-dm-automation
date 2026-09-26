#!/usr/bin/env node
/**
 * Move media out of Postgres into Supabase Storage (migration v23).
 *
 *   node --env-file=.env scripts/migrate-media-to-storage.mjs                  dry run: what would move
 *   node --env-file=.env scripts/migrate-media-to-storage.mjs --apply          move it
 *   node --env-file=.env scripts/migrate-media-to-storage.mjs --apply --limit 20   at most 20 files this run
 *
 * For every `media_uploads` row that still holds its bytes in `data`:
 *
 *   1. upload them to `<creator_id>/<id><ext>` in the `media` bucket — upsert, so a run that died
 *      after an upload simply uploads again;
 *   2. download that object back and compare sha256 and length with the bytes in Postgres. The copy
 *      is trusted only once it has been read back identical;
 *   3. set `storage_path` and `size_bytes` and clear `data`, in one statement, so there is never a
 *      moment when the row has no bytes anywhere. From then on the app streams the Storage copy.
 *
 * Nothing about a row changes until its copy is proven, so it is safe to stop at any point and run
 * it again: finished rows no longer have `data` and are not picked up twice. A row whose copy does
 * not verify keeps its bytes in Postgres, is reported, and makes the run exit non-zero.
 *
 * It uses the app's own config, the same way the app reads it: Settings → Media storage
 * (`app_settings`, the key decrypted with TOKEN_ENCRYPTION_KEY), then SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY. The Supabase calls mirror src/services/supabaseStorage.ts — plain ESM
 * cannot import TypeScript — and `mediaBackfill.test.ts` holds the two to the same headers and paths.
 *
 * Postgres does not return the freed space to the tier by itself; the run ends by printing the
 * VACUUM FULL that does.
 */
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import { pathToFileURL } from 'url';
import { decryptSecret, describeDbTarget, fmtBytes, loadEnv, parseArgs } from './lib/live.mjs';

export const MEDIA_BUCKET = 'media';
export const SERVER_USER_AGENT = 'autoreply-pro-server/1.0 (media storage)';
const SETTING_URL = 'storage.supabase_url';
const SETTING_KEY = 'storage.supabase_service_key';
const TRANSFER_TIMEOUT_MS = 300_000;
const JSON_TIMEOUT_MS = 15_000;

// ─── Mirrors of src/services/supabaseStorage.ts ─────────────────────────────────────────────

/** `apikey` always; `Authorization: Bearer` only for the legacy service_role JWT. A `sb_secret_` key is not a JWT. */
export function storageHeaders(key) {
    const headers = { apikey: key, 'User-Agent': SERVER_USER_AGENT };
    if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
    return headers;
}

const EXTENSIONS = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/quicktime': '.mov',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<creatorId>/<id><ext>`, exactly as the app names a new upload. */
export function objectPathFor(creatorId, id, mimeType) {
    if (!UUID.test(String(id))) throw new Error(`Not an upload id: ${JSON.stringify(id)}`);
    const folder = creatorId && UUID.test(String(creatorId)) ? String(creatorId).toLowerCase() : 'unassigned';
    return `${folder}/${String(id).toLowerCase()}${EXTENSIONS[mimeType] ?? ''}`;
}

/** An https origin (http only for localhost), or null — the app's `normaliseOrigin`. */
export function normaliseOrigin(input) {
    let url;
    try {
        url = new URL(String(input).trim());
    } catch {
        return null;
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    return url.origin;
}

export function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function storageError(response, action) {
    let body = null;
    try { body = JSON.parse(await response.text()); } catch { /* not JSON */ }
    const claimed = Number.parseInt(String(body?.statusCode ?? ''), 10);
    const status = Number.isFinite(claimed) && claimed >= 100 ? claimed : response.status;
    const err = new Error(`Supabase Storage refused to ${action}: ${body?.message ?? `HTTP ${response.status}`}`);
    err.status = status;
    err.code = body?.code ?? body?.error ?? null;
    return err;
}

const isNotFound = (err) => err.status === 404 || err.code === 'NoSuchBucket' || err.code === 'NoSuchKey';

/** The handful of Storage calls the backfill makes. */
export function storageClient({ url, key, fetchImpl = (input, init) => fetch(input, init) }) {
    const base = `${url.replace(/\/+$/, '')}/storage/v1`;
    const objectUrl = (prefix, objectPath) =>
        `${base}${prefix}/${MEDIA_BUCKET}/${objectPath.split('/').map(encodeURIComponent).join('/')}`;
    const headers = (extra = {}) => ({ ...storageHeaders(key), ...extra });

    return {
        /** `{ public }` for the bucket, or null when it does not exist. */
        async getBucket() {
            const response = await fetchImpl(`${base}/bucket/${MEDIA_BUCKET}`, {
                method: 'GET', headers: headers(), signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
            });
            if (response.ok) return { public: (await response.json()).public === true };
            const err = await storageError(response, 'read the bucket');
            if (isNotFound(err)) return null;
            throw err;
        },
        async createBucket() {
            const response = await fetchImpl(`${base}/bucket`, {
                method: 'POST',
                headers: headers({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ id: MEDIA_BUCKET, name: MEDIA_BUCKET, public: true }),
                signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
            });
            if (response.ok) return;
            const err = await storageError(response, 'create the bucket');
            if (err.status === 409) return;
            throw err;
        },
        /** Upsert: re-running after a crash overwrites the same bytes at the same path. */
        async upload(objectPath, data, contentType) {
            const response = await fetchImpl(objectUrl('/object', objectPath), {
                method: 'POST',
                headers: headers({ 'Content-Type': contentType, 'Cache-Control': 'max-age=31536000', 'x-upsert': 'true' }),
                body: data,
                signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
            });
            if (!response.ok) throw await storageError(response, 'upload the file');
            await response.body?.cancel().catch(() => undefined);
        },
        /** The object's bytes, or null when it is not there. */
        async download(objectPath) {
            const response = await fetchImpl(objectUrl('/object/authenticated', objectPath), {
                method: 'GET', headers: headers({ 'Accept-Encoding': 'identity' }), signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
            });
            if (response.ok) return Buffer.from(await response.arrayBuffer());
            const err = await storageError(response, 'download the file');
            if (isNotFound(err)) return null;
            throw err;
        },
        async remove(paths) {
            const response = await fetchImpl(`${base}/object/${MEDIA_BUCKET}`, {
                method: 'DELETE',
                headers: headers({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ prefixes: paths }),
                signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
            });
            if (!response.ok) throw await storageError(response, 'delete files');
        },
    };
}

// ─── The app's config ───────────────────────────────────────────────────────────────────────

/** Settings first, then the environment, each half on its own — as `getMediaStorageConfig` reads it. */
export async function resolveStorageConfig(db, env = process.env) {
    let saved = {};
    try {
        const { rows } = await db.query(
            'SELECT key, value, is_secret FROM app_settings WHERE key = ANY($1::text[])', [[SETTING_URL, SETTING_KEY]]
        );
        saved = Object.fromEntries(rows
            .filter((row) => row.value)
            .map((row) => [row.key, row.is_secret ? decryptSecret(row.value) : row.value]));
    } catch (err) {
        if (err?.code !== '42P01') throw err; // no app_settings table yet: nothing is saved
    }
    const rawUrl = saved[SETTING_URL] || env.SUPABASE_URL?.trim() || null;
    const url = rawUrl ? normaliseOrigin(rawUrl) : null;
    const key = saved[SETTING_KEY] || env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
    if (!url || !key) return null;
    return {
        url,
        key,
        source: { url: saved[SETTING_URL] ? 'Settings' : 'SUPABASE_URL', key: saved[SETTING_KEY] ? 'Settings' : 'SUPABASE_SERVICE_ROLE_KEY' },
    };
}

// ─── One row ────────────────────────────────────────────────────────────────────────────────

/**
 * Read the copy at `objectPath` back and compare it with the bytes it was made from.
 * `{ ok: true, sha256 }`, or `{ ok: false, reason }`.
 */
export async function verifyCopy(storage, objectPath, original) {
    const copy = await storage.download(objectPath);
    if (!copy) return { ok: false, reason: 'the object is not in the bucket' };
    if (copy.length !== original.length) {
        return { ok: false, reason: `${copy.length} bytes came back for ${original.length} sent` };
    }
    const want = sha256(original);
    const got = sha256(copy);
    if (got !== want) return { ok: false, reason: `sha256 ${got.slice(0, 12)}… came back for ${want.slice(0, 12)}… sent` };
    return { ok: true, sha256: want };
}

/**
 * Move one row. Throws when the copy cannot be made or does not verify — and then the row is
 * exactly as it was. Returns `{ status: 'moved', path, bytes, sha256 }`, or `{ status: 'gone' }`
 * when the row was deleted (or finished by another run) while this one worked.
 */
export async function migrateRow({ db, storage }, row) {
    const { rows: [fresh] } = await db.query(
        'SELECT data FROM media_uploads WHERE id = $1 AND data IS NOT NULL', [row.id]
    );
    if (!fresh) return { status: 'gone' };
    const data = fresh.data;
    const objectPath = row.storage_path ?? objectPathFor(row.creator_id, row.id, row.mime_type);

    await storage.upload(objectPath, data, row.mime_type);
    const verified = await verifyCopy(storage, objectPath, data);
    if (!verified.ok) throw new Error(`the copy did not verify: ${verified.reason}. Its bytes stay in Postgres.`);

    const updated = await db.query(
        `UPDATE media_uploads
            SET storage_path = $2, size_bytes = $3, data = NULL
          WHERE id = $1 AND data IS NOT NULL AND (storage_path IS NULL OR storage_path = $2)`,
        [row.id, objectPath, data.length]
    );
    if (updated.rowCount !== 1) {
        const { rows: [now] } = await db.query('SELECT storage_path FROM media_uploads WHERE id = $1', [row.id]);
        // Another run finished it, with these same bytes at this same path: keep the object.
        if (now && now.storage_path === objectPath) return { status: 'gone' };
        // The row was deleted while we uploaded. Nothing will ever name this object.
        await storage.remove([objectPath]).catch(() => undefined);
        return { status: 'gone' };
    }
    return { status: 'moved', path: objectPath, bytes: data.length, sha256: verified.sha256 };
}

// ─── The run ────────────────────────────────────────────────────────────────────────────────

const RECLAIM = `
Postgres keeps the space the moved bytes used until the table is rewritten. When nothing else is
using media_uploads, run this in the Supabase SQL editor:

    VACUUM FULL media_uploads;

It locks the table while it runs (seconds at this size); afterwards the database size drops.`;

async function main() {
    loadEnv(); // fills in anything --env-file did not, e.g. from a worktree; never overrides
    const args = parseArgs(process.argv.slice(2));
    const apply = args.apply === true;
    const limit = args.limit === undefined ? null : Number.parseInt(String(args.limit), 10);
    if (limit !== null && !(limit > 0)) throw new Error('--limit takes a positive number of files.');
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set. Run with node --env-file=.env.');

    const db = new pg.Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 15_000,
        application_name: 'autoreply-media-backfill',
    });
    await db.connect();
    try {
        console.log(`Media backfill ${apply ? '— APPLY' : '— dry run: nothing is written (add --apply to move files)'}`);
        console.log(`Database: ${describeDbTarget(process.env.DATABASE_URL)}`);

        const config = await resolveStorageConfig(db);
        if (!config) {
            console.log('Storage:  not configured. Save it in Settings → Media storage, or set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
            if (apply) { process.exitCode = 1; return; }
        } else {
            const kind = config.key.startsWith('sb_secret_') ? 'secret key' : config.key.startsWith('eyJ') ? 'legacy service_role key' : 'key of unknown format';
            console.log(`Storage:  ${config.url} (from ${config.source.url}), ${kind} (from ${config.source.key}), bucket "${MEDIA_BUCKET}"`);
        }
        const storage = config ? storageClient(config) : null;

        // The dry run reads inside a READ ONLY transaction: the database itself refuses a write,
        // and unlike SET SESSION nothing outlives it on a pooled connection.
        if (!apply) await db.query('BEGIN READ ONLY');

        const { rows: candidates } = await db.query(
            `SELECT id, creator_id, mime_type, storage_path, octet_length(data) AS bytes
               FROM media_uploads
              WHERE data IS NOT NULL
              ORDER BY created_at, id
              ${limit ? 'LIMIT $1' : ''}`,
            limit ? [limit] : []
        );
        const { rows: [size] } = await db.query(`SELECT pg_total_relation_size('media_uploads') AS bytes`);
        const total = candidates.reduce((sum, row) => sum + Number(row.bytes), 0);
        console.log(`media_uploads is ${fmtBytes(Number(size.bytes))} on disk. ${candidates.length} file(s) still in Postgres${limit ? ` (first ${limit})` : ''}: ${fmtBytes(total)}.`);

        if (!apply) {
            if (storage) {
                try {
                    const bucket = await storage.getBucket();
                    console.log(bucket ? `Bucket "${MEDIA_BUCKET}" exists${bucket.public ? ', public' : ', private'}.` : `Bucket "${MEDIA_BUCKET}" does not exist yet; --apply creates it, public.`);
                } catch (err) {
                    console.log(`Could not read the bucket, so --apply would fail too: ${err?.message ?? err}`);
                }
            }
            for (const row of candidates) {
                const target = row.storage_path ?? objectPathFor(row.creator_id, row.id, row.mime_type);
                console.log(`  ${row.id}  ${row.mime_type.padEnd(15)} ${fmtBytes(Number(row.bytes)).padStart(7)}  → ${MEDIA_BUCKET}/${target}`);
            }
            await db.query('COMMIT');
            console.log('\nNothing was written. Re-run with --apply to move these, then VACUUM FULL media_uploads to reclaim the space.');
            return;
        }

        const bucket = await storage.getBucket();
        if (!bucket) {
            await storage.createBucket();
            console.log(`Created the public bucket "${MEDIA_BUCKET}".`);
        }

        let moved = 0;
        let movedBytes = 0;
        const failed = [];
        for (const row of candidates) {
            try {
                const outcome = await migrateRow({ db, storage }, row);
                if (outcome.status === 'moved') {
                    moved++;
                    movedBytes += outcome.bytes;
                    console.log(`  ✓ ${row.id} ${fmtBytes(outcome.bytes).padStart(7)} → ${outcome.path}  sha256 ${outcome.sha256.slice(0, 12)}… verified`);
                } else {
                    console.log(`  – ${row.id} was deleted or finished elsewhere while this ran; skipped`);
                }
            } catch (err) {
                failed.push(row.id);
                console.error(`  ✗ ${row.id}: ${err?.message ?? err}`);
            }
        }

        console.log(`\nMoved ${moved} of ${candidates.length} file(s), ${fmtBytes(movedBytes)}.`);
        if (failed.length) {
            console.error(`${failed.length} failed and kept their bytes in Postgres. Run again to retry them.`);
            process.exitCode = 1;
        }
        console.log(RECLAIM);
    } finally {
        await db.end().catch(() => {});
    }
}

// Run only when executed, so the test can import the pieces without touching a database.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch((err) => {
        console.error(err?.message ?? err);
        process.exitCode = 1;
    });
}
