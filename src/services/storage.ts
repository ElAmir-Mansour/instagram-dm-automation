/**
 * Media storage.
 *
 * Uploads used to live in `media_uploads.data`, a BYTEA column: 267MB of a 281MB database on
 * Supabase's 500MB tier, with every Meta ingestion pulling the bytes over the Postgres connection.
 * From migration v23 new uploads go to Supabase Storage (1GB free) whenever the operator has
 * configured it — Settings → Media storage, or `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` —
 * and stay in Postgres when nothing is configured. `getMediaStore()` makes that choice, per
 * call, from the config in `app_settings`.
 *
 * Either way a row is found by its id and served as `/api/uploads/<id>` from this app's own
 * domain. That is deliberate and must not change: TikTok pulls photos only from the URL prefix
 * verified in its portal, and Meta already holds these URLs on scheduled and published posts.
 * The object's own Supabase URL is never handed out.
 *
 * Two kinds of row therefore exist side by side, and every read handles both:
 *
 *   storage_path set    the bytes are an object in the `media` bucket. The route streams it.
 *   storage_path NULL   a legacy row: the bytes are in `data`, served as before.
 *
 * `scripts/migrate-media-to-storage.mjs` moves legacy rows across, verifying each copy before it
 * clears `data`.
 *
 * Deleting a row queues its object (a trigger, migration v23) and `removeQueuedMediaObjects`
 * removes it from Storage on the daily retention sweep — so a rolled-back delete never leaves a
 * row whose object is gone.
 *
 * ── Private rows (migration v51) ──
 *
 * A customer's file (a WhatsApp voice note, a receipt) is stored with `is_private = true`. Every
 * read here decides in one place, `mayRead`, and the default is the public one: without
 * `privateFor`, `open`, `get` and `mimeTypes` answer "no such upload" for a private row, so
 * `GET /api/uploads/:id` (which calls `open`) answers 404 for it exactly as for an id that never
 * existed, and a scheduled post can neither publish it nor pass validation with it. Only
 * `privateFor: <creator id>` reaches it, and only when the row belongs to that tenant: the
 * authenticated inbox route and the transcription.
 *
 * With Supabase Storage configured a private upload's bytes are an object in the PRIVATE bucket
 * `media-private` (created on first use with `public: false`, and refused if it exists and is
 * public), at `private/<creator>/<id><ext>`; the app reads it with the secret key, like every
 * object. The public bucket `media` never receives one. Without Storage configured (legacy BYTEA
 * mode) the bytes stay in `data`, and `is_private` alone keeps the public route away from them.
 * The `private/` prefix names the bucket from a path alone (`bucketForPath`), which is all the
 * deletion queue has to go on.
 *
 * Reads select `is_private` and fall back to the pre-v51 statement on `undefined_column`: no
 * private row can exist before the migration, so a deployment ahead of its database serves every
 * upload as it always did. Nothing is cached — once the column exists the next read sees it.
 */
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { queryCount, queryOne, queryRows } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import type { MediaObjectDeletionRow, MediaUploadRow } from '../db/rows.js';
import { APP_SETTING_KEYS, getMediaStorageConfig, getSetting, maskValue, type MediaStorageConfig } from './appSettings.js';
import {
    bucketForPath, MEDIA_BUCKET, MAX_REMOVE_PER_REQUEST, objectPathFor, PRIVATE_MEDIA_BUCKET, StorageApiError, storageKeyKind,
    SupabaseStorageClient, type StorageKeyKind,
} from './supabaseStorage.js';

export interface PutMediaInput {
    creatorId: string;
    filename: string;
    mimeType: string;
    data: Buffer;
    /**
     * A customer's file (WhatsApp inbound media): stored `is_private`, never served by the public route. Needs migration v51 and fails
     * loudly without it, rather than quietly storing a customer's file as public.
     */
    private?: boolean;
}

export interface StoredMedia {
    id: string;
    mimeType: string;
    data: Buffer;
}

/** What `GET /api/uploads/:id` sends back. */
export type MediaContent =
    /** A legacy row. pg hands a BYTEA column over whole, so these are bytes, as they always were. */
    | { kind: 'bytes'; id: string; mimeType: string; data: Buffer }
    /**
     * An object in Storage, to be streamed. `size` is the Content-Length when known. `body` is
     * null when only the headers were asked for (HEAD), so nothing was fetched.
     */
    | { kind: 'stream'; id: string; mimeType: string; size: number | null; body: Readable | null };

export interface OpenOptions {
    /** A HEAD request: answer from the row, without fetching the object. */
    headOnly?: boolean;
    /**
     * Read a PRIVATE upload of this tenant instead of a public one. Without it a private row is "not found"; with it only a private row
     * of exactly this creator is found. For the authenticated inbox route, never for `/api/uploads/:id`.
     */
    privateFor?: string;
}

export interface GetOptions {
    /** As `OpenOptions.privateFor`: the bytes of a private upload of this tenant (the transcription reads a voice note this way). */
    privateFor?: string;
}

export interface MediaStore {
    /** Store bytes and return the id the public URL is built from. */
    put(input: PutMediaInput): Promise<{ id: string }>;
    /**
     * The whole file, or null when it does not exist. For callers that need every byte (TikTok's FILE_UPLOAD). A private upload is null
     * unless `privateFor` names its tenant.
     */
    get(id: string, options?: GetOptions): Promise<StoredMedia | null>;
    /** What the upload route serves: a stream for a Storage row, never the object buffered. */
    open(id: string, options?: OpenOptions): Promise<MediaContent | null>;
    /**
     * What each id is stored as, without reading its bytes — validating a 35-photo carousel
     * must not pull 35 files. Ids that do not exist are absent, and so are private ones: a post cannot name a customer's file.
     */
    mimeTypes(ids: readonly string[]): Promise<Map<string, string>>;
    /**
     * The URL Meta and TikTok fetch: always this app's own `/api/uploads/<id>`, whichever store
     * holds the bytes. Takes the origin because the caller decides which one is public.
     */
    publicUrl(id: string, origin: string): string;
}

/**
 * A row's object is in Storage and there is no Storage config to fetch it with — someone removed
 * it with files still in the bucket. The route answers 503, which is the truth: the file exists,
 * this deployment just cannot reach it.
 */
export class MediaStorageUnavailableError extends Error {
    constructor(readonly mediaId: string) {
        super(`Upload ${mediaId} is in Supabase Storage, and no Storage config is set to read it with.`);
        this.name = 'MediaStorageUnavailableError';
    }
}

interface LocatedRow {
    mime_type: string;
    storage_path: string | null;
    /** BIGINT, which pg returns as a string. */
    size_bytes: string | number | null;
    data: Buffer | null;
    /** Absent when the row was read by the pre-v51 statement: such a row is public. */
    is_private?: boolean | null;
    creator_id?: string | null;
}

/** `undefined_column`: the database is behind this build (migration v51 not applied). */
const isMissingColumn = (err: unknown): boolean => (err as { code?: string } | null)?.code === '42703';

/**
 * Whether a row may be served to the public: `GET /api/uploads/:id`, a post's media, Meta's and TikTok's fetchers. Everything but a
 * private row. The one question the public route's answer depends on, kept apart so a test can pin it.
 */
export function canServePublicly(row: { is_private?: boolean | null }): boolean {
    return row.is_private !== true;
}

/** Whether a PRIVATE row may be read by this tenant: it is private, and it is theirs. Both, or neither. */
export function canServePrivately(row: { is_private?: boolean | null; creator_id?: string | null }, creatorId: string): boolean {
    return row.is_private === true
        && typeof creatorId === 'string' && creatorId !== ''
        && typeof row.creator_id === 'string'
        && row.creator_id.toLowerCase() === creatorId.toLowerCase();
}

/** The decision every read goes through: the public rule by default, the tenant's private rule only when `privateFor` is given. */
function mayRead(row: { is_private?: boolean | null; creator_id?: string | null }, privateFor: string | undefined): boolean {
    return privateFor === undefined ? canServePublicly(row) : canServePrivately(row, privateFor);
}

/**
 * Where a row's bytes are, fetching `data` only when it is what will be served. A row part way
 * through the backfill has both; Storage wins where Storage is configured, because the copy was
 * verified before `storage_path` was set.
 *
 * Selects `is_private` and `creator_id` for `mayRead`; before migration v51 the first statement fails with `undefined_column` and the
 * statement this file always ran answers instead (no row is private yet).
 */
async function locate(id: string, prefer: 'storage' | 'database'): Promise<LocatedRow | null> {
    try {
        return await queryOne<LocatedRow>(
            prefer === 'storage'
                ? `SELECT mime_type, storage_path, size_bytes, is_private, creator_id,
                          CASE WHEN storage_path IS NULL THEN data END AS data
                     FROM media_uploads WHERE id = $1`
                : 'SELECT mime_type, storage_path, size_bytes, is_private, creator_id, data FROM media_uploads WHERE id = $1',
            [id]
        );
    } catch (err) {
        if (!isMissingColumn(err)) throw err;
        return queryOne<LocatedRow>(
            prefer === 'storage'
                ? `SELECT mime_type, storage_path, size_bytes,
                          CASE WHEN storage_path IS NULL THEN data END AS data
                     FROM media_uploads WHERE id = $1`
                : 'SELECT mime_type, storage_path, size_bytes, data FROM media_uploads WHERE id = $1',
            [id]
        );
    }
}

function sizeOf(value: string | number | null): number | null {
    if (value === null) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

async function mimeTypesOf(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    let rows: Pick<MediaUploadRow, 'id' | 'mime_type'>[];
    try {
        // Public rows only: a post cannot name a customer's file (see the header). Before v51 there is no such row, so the old statement is exact.
        rows = await queryRows<Pick<MediaUploadRow, 'id' | 'mime_type'>>(
            'SELECT id, mime_type FROM media_uploads WHERE id = ANY($1::uuid[]) AND NOT is_private',
            [[...ids]]
        );
    } catch (err) {
        if (!isMissingColumn(err)) throw err;
        rows = await queryRows<Pick<MediaUploadRow, 'id' | 'mime_type'>>(
            'SELECT id, mime_type FROM media_uploads WHERE id = ANY($1::uuid[])',
            [[...ids]]
        );
    }
    return new Map(rows.map((row) => [String(row.id).toLowerCase(), row.mime_type]));
}

function uploadsUrl(id: string, origin: string): string {
    return `${origin}/api/uploads/${id}`;
}

/**
 * Bytes in Postgres. What runs when no Storage is configured, and what legacy rows are.
 */
export class PostgresMediaStore implements MediaStore {
    async put(input: PutMediaInput): Promise<{ id: string }> {
        // The statement of a public upload is exactly what it was before v51. A private one names the column, so a database without it fails
        // here instead of storing a customer's file as public.
        const row = input.private
            ? await queryOne<Pick<MediaUploadRow, 'id'>>(
                `INSERT INTO media_uploads (creator_id, filename, mime_type, data, size_bytes, is_private)
                 VALUES ($1, $2, $3, $4, $5, true)
                 RETURNING id`,
                [input.creatorId, input.filename, input.mimeType, input.data, input.data.length]
            )
            : await queryOne<Pick<MediaUploadRow, 'id'>>(
                `INSERT INTO media_uploads (creator_id, filename, mime_type, data, size_bytes)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id`,
                [input.creatorId, input.filename, input.mimeType, input.data, input.data.length]
            );

        if (!row) {
            // An INSERT ... RETURNING that returns nothing means the row was not written.
            // Better to fail here than to hand back a URL that will 404 when Meta fetches it
            // — a scheduled post would then fail at publish time with an opaque Meta error.
            throw new Error('media_uploads insert returned no row.');
        }

        log('info', 'media.stored', {
            media_id: row.id,
            bytes: input.data.length,
            mime_type: input.mimeType,
            backend: 'postgres',
            ...(input.private ? { private: true } : {}),
        });
        return { id: row.id };
    }

    async get(id: string, options: GetOptions = {}): Promise<StoredMedia | null> {
        const row = await locate(id, 'database');
        if (!row || !mayRead(row, options.privateFor)) return null;
        if (row.data) return { id, mimeType: row.mime_type, data: row.data };
        throw new MediaStorageUnavailableError(id);
    }

    async open(id: string, options: OpenOptions = {}): Promise<MediaContent | null> {
        const row = await locate(id, 'database');
        if (!row || !mayRead(row, options.privateFor)) return null;
        if (row.data) return { kind: 'bytes', id, mimeType: row.mime_type, data: row.data };
        throw new MediaStorageUnavailableError(id);
    }

    mimeTypes(ids: readonly string[]): Promise<Map<string, string>> {
        return mimeTypesOf(ids);
    }

    publicUrl(id: string, origin: string): string {
        return uploadsUrl(id, origin);
    }
}

/**
 * The private bucket exists and is PUBLIC: someone made it so, by hand. A customer's file must not be written to it, so nothing is.
 * The operator turns the bucket private in Supabase (Storage, `media-private`, Edit bucket), or deletes it if it is empty.
 */
export class PrivateBucketIsPublicError extends Error {
    constructor() {
        super(`The Storage bucket "${PRIVATE_MEDIA_BUCKET}" is public, so no customer file was written to it. Make it private in Supabase (Storage, ${PRIVATE_MEDIA_BUCKET}, Edit bucket) and try again.`);
        this.name = 'PrivateBucketIsPublicError';
    }
}

/**
 * Bytes in the Supabase Storage bucket `media`, at `<creatorId>/<id><ext>`; the row keeps the
 * metadata with `data` NULL. Legacy rows are still served from `data`. A private upload goes to
 * the private bucket instead (see the header): `clientFor(path)` picks the bucket from the path.
 */
export class SupabaseStorageMediaStore implements MediaStore {
    readonly client: SupabaseStorageClient;
    /** The private bucket's client: customer files only, never a post's media. */
    readonly privateClient: SupabaseStorageClient;
    /** Checked once per instance, and instances are kept per config (`getMediaStore`). */
    private bucketReady: Promise<unknown> | null = null;
    private privateBucketReady: Promise<unknown> | null = null;

    constructor(readonly config: MediaStorageConfig) {
        this.client = new SupabaseStorageClient({ url: config.url, key: config.key, bucket: MEDIA_BUCKET });
        this.privateClient = new SupabaseStorageClient({ url: config.url, key: config.key, bucket: PRIVATE_MEDIA_BUCKET });
    }

    /** The client of the bucket this path lives in: `private/…` in the private bucket, everything else in `media`. */
    private clientFor(path: string): SupabaseStorageClient {
        return bucketForPath(path) === PRIVATE_MEDIA_BUCKET ? this.privateClient : this.client;
    }

    /**
     * Creates the private bucket `media-private` the first time this instance needs it, with `public: false`, exactly as `ensureBucket`
     * does for `media`, and checks what is there: a bucket that exists and is public is refused (`PrivateBucketIsPublicError`), on every call
     * until it is fixed. Only a bucket seen to be private is remembered.
     */
    private ensurePrivateBucket(): Promise<unknown> {
        this.privateBucketReady ??= this.privateClient.ensureBucket({ public: false }).then((outcome) => {
            if (outcome.public) throw new PrivateBucketIsPublicError();
            if (outcome.created) log('info', 'media.bucket_created', { bucket: PRIVATE_MEDIA_BUCKET, public: false });
            return outcome;
        }).catch((err) => {
            this.privateBucketReady = null; // try again on the next upload rather than failing forever
            if (err instanceof PrivateBucketIsPublicError) log('error', 'media.private_bucket_public', { bucket: PRIVATE_MEDIA_BUCKET });
            throw err;
        });
        return this.privateBucketReady;
    }

    /** Creates the public bucket `media` the first time this instance needs it, if it is missing. */
    private ensureBucket(): Promise<unknown> {
        this.bucketReady ??= this.client.ensureBucket().then((outcome) => {
            if (outcome.created) log('info', 'media.bucket_created', { bucket: MEDIA_BUCKET });
            return outcome;
        }).catch((err) => {
            this.bucketReady = null; // try again on the next upload rather than failing forever
            throw err;
        });
        return this.bucketReady;
    }

    async put(input: PutMediaInput): Promise<{ id: string }> {
        // The id is made here, not by Postgres, because the object is written first and its path
        // carries the id. Same uuid shape as ever, so the URL is unchanged.
        const id = randomUUID();
        const path = objectPathFor(input.creatorId, id, input.mimeType, { private: input.private === true });

        // A customer's file goes to the private bucket and ONLY there; a post's media to `media`, as it always did.
        if (input.private) await this.ensurePrivateBucket();
        else await this.ensureBucket();
        await this.clientFor(path).upload(path, input.data, input.mimeType);

        let row: Pick<MediaUploadRow, 'id'> | null;
        try {
            row = input.private
                ? await queryOne<Pick<MediaUploadRow, 'id'>>(
                    `INSERT INTO media_uploads (id, creator_id, filename, mime_type, data, storage_path, size_bytes, is_private)
                     VALUES ($1, $2, $3, $4, NULL, $5, $6, true)
                     RETURNING id`,
                    [id, input.creatorId, input.filename, input.mimeType, path, input.data.length]
                )
                : await queryOne<Pick<MediaUploadRow, 'id'>>(
                    `INSERT INTO media_uploads (id, creator_id, filename, mime_type, data, storage_path, size_bytes)
                     VALUES ($1, $2, $3, $4, NULL, $5, $6)
                     RETURNING id`,
                    [id, input.creatorId, input.filename, input.mimeType, path, input.data.length]
                );
        } catch (err) {
            await this.discard(path);
            throw err;
        }
        if (!row) {
            await this.discard(path);
            throw new Error('media_uploads insert returned no row.');
        }

        log('info', 'media.stored', {
            media_id: row.id,
            bytes: input.data.length,
            mime_type: input.mimeType,
            backend: 'supabase',
            ...(input.private ? { private: true } : {}),
        });
        return { id: row.id };
    }

    /** The object was written but its row was not: nothing will ever name it, so take it back out. */
    private async discard(path: string): Promise<void> {
        try {
            await this.clientFor(path).remove([path]);
        } catch (err) {
            log('error', 'media.orphan_object', { storage_path: path, message: (err as Error)?.message });
        }
    }

    async get(id: string, options: GetOptions = {}): Promise<StoredMedia | null> {
        const row = await locate(id, 'storage');
        if (!row || !mayRead(row, options.privateFor)) return null;
        if (!row.storage_path) return row.data ? { id, mimeType: row.mime_type, data: row.data } : null;

        const data = await this.clientFor(row.storage_path).download(row.storage_path);
        if (!data) {
            log('error', 'media.object_missing', { media_id: id, storage_path: row.storage_path });
            return null;
        }
        return { id, mimeType: row.mime_type, data };
    }

    async open(id: string, options: OpenOptions = {}): Promise<MediaContent | null> {
        const row = await locate(id, 'storage');
        if (!row || !mayRead(row, options.privateFor)) return null;
        if (!row.storage_path) {
            return row.data ? { kind: 'bytes', id, mimeType: row.mime_type, data: row.data } : null;
        }

        const recorded = sizeOf(row.size_bytes);
        if (options.headOnly) return { kind: 'stream', id, mimeType: row.mime_type, size: recorded, body: null };

        const object = await this.clientFor(row.storage_path).openStream(row.storage_path);
        if (!object) {
            // The row says the object exists and Storage says it does not. Nothing the caller can
            // do about it, so a 404 — but loudly, because it means a file was lost.
            log('error', 'media.object_missing', { media_id: id, storage_path: row.storage_path });
            return null;
        }
        if (recorded !== null && object.length !== null && recorded !== object.length) {
            log('warn', 'media.size_mismatch', { media_id: id, recorded_bytes: recorded, stored_bytes: object.length });
        }
        // What Supabase says it is sending wins: a Content-Length that disagrees with the body
        // makes Node abort the response.
        return { kind: 'stream', id, mimeType: row.mime_type, size: object.length ?? recorded, body: object.body };
    }

    mimeTypes(ids: readonly string[]): Promise<Map<string, string>> {
        return mimeTypesOf(ids);
    }

    publicUrl(id: string, origin: string): string {
        return uploadsUrl(id, origin);
    }
}

const UPLOAD_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/**
 * `/api/uploads/<id>` also answers with an extension on the end. Only TikTok needs one — its
 * photo fetcher wants a URL that looks like an image — and it is ignored: the stored mime type
 * is what gets served.
 */
const UPLOAD_EXTENSION = '(?:\\.(?:jpe?g|png|webp|mp4))?';
const UPLOAD_URL_PATTERN = new RegExp(`/api/uploads/(${UPLOAD_ID})${UPLOAD_EXTENSION}(?:[/?#]|$)`, 'i');
const UPLOAD_SEGMENT_PATTERN = new RegExp(`^(${UPLOAD_ID})${UPLOAD_EXTENSION}$`, 'i');

/** The `<uuid>` of one of our own `/api/uploads/<uuid>` URLs, from any origin, or null. */
export function uploadIdFromUrl(url: string): string | null {
    const match = UPLOAD_URL_PATTERN.exec(url);
    return match ? match[1]!.toLowerCase() : null;
}

/**
 * The id in the route's `:id` segment, or null. Express 5 hands over the whole segment, so
 * `<uuid>.jpg` arrives as one string — and anything that is not a uuid has to stop here,
 * because Postgres answers a malformed uuid literal with an error rather than no rows.
 */
export function uploadIdFromSegment(segment: unknown): string | null {
    if (typeof segment !== 'string') return null;
    const match = UPLOAD_SEGMENT_PATTERN.exec(segment);
    return match ? match[1]!.toLowerCase() : null;
}

const postgresStore = new PostgresMediaStore();
let supabaseStore: { url: string; key: string; store: SupabaseStorageMediaStore } | null = null;
let storeOverride: MediaStore | null = null;

/**
 * The store new uploads go to: Supabase Storage when the operator has configured it (Settings
 * first, then `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`), Postgres otherwise.
 *
 * Read on every call, like the Gemini key: a config saved in Settings has to reach every warm
 * instance at once, and it is two indexed rows. The instance is kept while the config is
 * unchanged, so its bucket check happens once.
 */
export async function getMediaStore(): Promise<MediaStore> {
    if (storeOverride) return storeOverride;
    const config = await getMediaStorageConfig();
    if (!config) return postgresStore;
    if (!supabaseStore || supabaseStore.url !== config.url || supabaseStore.key !== config.key) {
        supabaseStore = { url: config.url, key: config.key, store: new SupabaseStorageMediaStore(config) };
    }
    return supabaseStore.store;
}

/** Override the store — tests only. Returns the previous override. */
export function setMediaStore(next: MediaStore | null): MediaStore | null {
    const previous = storeOverride;
    storeOverride = next;
    return previous;
}

// ─── Removing objects whose rows were deleted ────────────────────────────────────────────────

export type ObjectRemovalOutcome =
    | { removed: number; failed: number; skipped: false }
    /** Objects are queued but there is no Storage config to remove them with. They wait. */
    | { removed: 0; failed: 0; skipped: true; reason: 'unconfigured'; waiting: number }
    /** The queue could not be read — before migration v23, say. Nothing was attempted. */
    | { removed: 0; failed: 0; skipped: true; reason: 'error' };

/**
 * Remove the objects of deleted rows from Storage.
 *
 * The queue is written by the v23 trigger in the same transaction as each DELETE, so it holds
 * exactly the objects whose rows are gone for good. An entry leaves the queue only once Supabase
 * has confirmed the delete; a failure keeps it, counts the attempt and records why, and the next
 * sweep tries again. Removing an object that is already gone is not an error, so a retry is safe.
 *
 * Never throws: it runs in the cron invocation that publishes scheduled posts.
 */
export async function removeQueuedMediaObjects(limit = MAX_REMOVE_PER_REQUEST): Promise<ObjectRemovalOutcome> {
    let paths: string[];
    try {
        const rows = await queryRows<Pick<MediaObjectDeletionRow, 'storage_path'>>(
            'SELECT storage_path FROM media_object_deletions ORDER BY queued_at, storage_path LIMIT $1',
            [limit]
        );
        paths = rows.map((row) => row.storage_path);
    } catch (err) {
        log('error', 'media.object_queue_unreadable', describeError(err));
        return { removed: 0, failed: 0, skipped: true, reason: 'error' };
    }
    if (paths.length === 0) return { removed: 0, failed: 0, skipped: false };

    let config: MediaStorageConfig | null;
    try {
        config = await getMediaStorageConfig();
    } catch (err) {
        log('error', 'media.object_queue_unreadable', describeError(err));
        return { removed: 0, failed: 0, skipped: true, reason: 'error' };
    }
    if (!config) {
        log('warn', 'media.objects_waiting', { waiting: paths.length, reason: 'storage_unconfigured' });
        return { removed: 0, failed: 0, skipped: true, reason: 'unconfigured', waiting: paths.length };
    }

    // The queue holds paths and nothing else, so the bucket is read off each path (`private/…` is the private bucket's). One request per
    // bucket; a bucket that fails keeps its entries and does not hold back the other's.
    const byBucket = new Map<string, string[]>();
    for (const path of paths) {
        const bucket = bucketForPath(path);
        byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), path]);
    }

    const removed: string[] = [];
    let failed = 0;
    for (const [bucket, group] of byBucket) {
        const client = new SupabaseStorageClient({ url: config.url, key: config.key, bucket });
        try {
            await client.remove(group);
            removed.push(...group);
        } catch (err) {
            const message = (err as Error)?.message ?? 'unknown error';
            log('error', 'media.objects_remove_failed', { count: group.length, bucket, message });
            await queryCount(
                `UPDATE media_object_deletions
                    SET attempts = attempts + 1, last_error = $2
                  WHERE storage_path = ANY($1::text[])`,
                [group, message.slice(0, 500)]
            ).catch(() => undefined);
            failed += group.length;
        }
    }

    if (removed.length > 0) {
        try {
            await queryCount('DELETE FROM media_object_deletions WHERE storage_path = ANY($1::text[])', [removed]);
        } catch (err) {
            // The objects are gone; the entries stay and the next sweep deletes nothing twice over.
            log('warn', 'media.object_queue_not_cleared', describeError(err));
        }
        log('info', 'media.objects_removed', { count: removed.length });
    }
    return { removed: removed.length, failed, skipped: false };
}

// ─── What the Settings card shows ────────────────────────────────────────────────────────────

/** Supabase's free Storage allowance, which the card measures against. */
export const STORAGE_TIER_BYTES = 1024 ** 3;

export interface MediaUsage {
    /** Rows whose bytes are an object in Storage, and what they add up to. */
    storage: { files: number; bytes: number };
    /** Rows whose bytes are still in `media_uploads.data`. The backfill moves them. */
    database: { files: number; bytes: number };
    /** Objects of deleted rows not yet removed from Storage. */
    queuedDeletions: number;
    tierBytes: number;
}

export async function getMediaUsage(): Promise<MediaUsage> {
    const row = await queryOne<{
        storage_files: string; storage_bytes: string; database_files: string; database_bytes: string; queued: string;
    }>(
        `SELECT count(*) FILTER (WHERE storage_path IS NOT NULL)                        AS storage_files,
                COALESCE(sum(size_bytes) FILTER (WHERE storage_path IS NOT NULL), 0)    AS storage_bytes,
                count(*) FILTER (WHERE data IS NOT NULL)                                AS database_files,
                COALESCE(sum(octet_length(data)), 0)                                    AS database_bytes,
                (SELECT count(*) FROM media_object_deletions)                           AS queued
           FROM media_uploads`
    );
    const n = (value: string | undefined) => Number(value ?? 0) || 0;
    return {
        storage: { files: n(row?.storage_files), bytes: n(row?.storage_bytes) },
        database: { files: n(row?.database_files), bytes: n(row?.database_bytes) },
        queuedDeletions: n(row?.queued),
        tierBytes: STORAGE_TIER_BYTES,
    };
}

export type StorageCheck =
    | { ok: true; bucketExists: boolean; public: boolean | null; created: boolean }
    /** 400: Supabase refused the key. 502: Supabase could not be asked. */
    | { ok: false; status: 400 | 502; error: string };

/**
 * Ask Supabase whether this config works, by reading the bucket — and, with `create`, making it
 * public if it is missing. What Settings runs before saving, so a wrong key is never saved.
 */
export async function checkMediaStorage(
    config: Pick<MediaStorageConfig, 'url' | 'key'>, options: { create?: boolean } = {}
): Promise<StorageCheck> {
    const client = new SupabaseStorageClient({ url: config.url, key: config.key, bucket: MEDIA_BUCKET });
    try {
        if (options.create) {
            const outcome = await client.ensureBucket();
            return { ok: true, bucketExists: true, public: outcome.public, created: outcome.created };
        }
        const bucket = await client.getBucket();
        return { ok: true, bucketExists: Boolean(bucket), public: bucket ? bucket.public : null, created: false };
    } catch (err) {
        if (err instanceof StorageApiError && !err.unreachable && err.status < 500) {
            return { ok: false, status: 400, error: err.message };
        }
        return { ok: false, status: 502, error: (err as Error)?.message ?? 'Could not reach Supabase Storage.' };
    }
}

export interface MediaStorageStatus {
    /** Where new uploads go right now. */
    backend: 'supabase' | 'postgres';
    bucket: string;
    url: { value: string | null; source: 'database' | 'env' | null };
    /** Never the key: whether one is set, where from, its kind, and a masked hint of a saved one. */
    key: { set: boolean; source: 'database' | 'env' | null; kind: StorageKeyKind | null; preview: string | null };
    /** Which env fallbacks exist, so the card can say what removing the saved config falls back to. */
    env: { url: boolean; key: boolean };
    /** Supabase's live answer. Null when there is nothing configured to ask with. */
    connection: StorageCheck | null;
    usage: MediaUsage | null;
    usageError?: string;
}

/** Everything the Settings card shows, including a live round trip to Supabase. Never the key. */
export async function describeMediaStorage(): Promise<MediaStorageStatus> {
    const [config, savedUrl, savedKey] = await Promise.all([
        getMediaStorageConfig(),
        getSetting(APP_SETTING_KEYS.mediaStorageUrl),
        getSetting(APP_SETTING_KEYS.mediaStorageKey),
    ]);
    const envUrl = Boolean(process.env.SUPABASE_URL?.trim());
    const envKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
    const keyValue = savedKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? null;

    let usage: MediaUsage | null = null;
    let usageError: string | undefined;
    try {
        usage = await getMediaUsage();
    } catch (err) {
        usageError = (err as Error)?.message ?? 'Could not measure media.';
    }

    return {
        backend: config ? 'supabase' : 'postgres',
        bucket: MEDIA_BUCKET,
        url: {
            value: config?.url ?? savedUrl ?? null,
            source: config ? config.source.url : (savedUrl ? 'database' : envUrl ? 'env' : null),
        },
        key: {
            set: Boolean(keyValue),
            source: savedKey ? 'database' : envKey ? 'env' : null,
            kind: keyValue ? storageKeyKind(keyValue) : null,
            preview: savedKey ? maskValue(savedKey) : null,
        },
        env: { url: envUrl, key: envKey },
        connection: config ? await checkMediaStorage(config) : null,
        usage,
        ...(usageError ? { usageError } : {}),
    };
}
