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
import { parseByteRange } from '../utils/byteRange.js';
import { describeError, log } from '../utils/log.js';
import type { MediaObjectDeletionRow, MediaUploadRow } from '../db/rows.js';
import {
    APP_SETTING_KEYS, DEFAULT_R2_BUCKET, getMediaConfigs, getMediaStorageConfig, getPublicBaseUrl, getSetting, getSettings, maskValue, type MediaStorageConfig, type R2Config,
} from './appSettings.js';
import { readCopyStatus, type R2CopyStatus } from './r2Copy.js';
import { R2StorageClient, r2CorsPolicy } from './r2Storage.js';
import { assertR2Room, R2LimitError, readR2Summary, type R2UsageSummary } from './r2Usage.js';
import {
    bucketForPath, isR2Path, MEDIA_BUCKET, MAX_REMOVE_PER_REQUEST, objectPathFor, PRIVATE_MEDIA_BUCKET, R2_BUCKET_TOKEN, R2_PATH_PREFIX, r2KeyOf, StorageApiError,
    storageKeyKind, SupabaseStorageClient, type ObjectStorageClient, type SignedUpload, type StorageKeyKind,
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
    | {
        kind: 'stream'; id: string; mimeType: string; size: number | null; body: Readable | null;
        /** Set when `body` is only these bytes (inclusive) of a `total`-byte object: the route answers 206. `size` is the slice's. */
        range?: { start: number; end: number; total: number };
    }
    /** The Range asked for lies wholly past the end of the object: the route answers 416. Nothing was fetched. */
    | { kind: 'unsatisfiable'; id: string; mimeType: string; total: number };

export interface OpenOptions {
    /** A HEAD request: answer from the row, without fetching the object. */
    headOnly?: boolean;
    /**
     * The request's `Range` header, as sent. A single byte range of a Storage row whose size is recorded is fetched as just those
     * bytes (`src/utils/byteRange.ts`); anything else is ignored and the whole object streamed. A legacy BYTEA row ignores it here:
     * the route slices those bytes itself.
     */
    range?: unknown;
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
    constructor(readonly mediaId: string, readonly backend: 'supabase' | 'r2' = 'supabase') {
        super(`Upload ${mediaId} is in ${backend === 'r2' ? 'Cloudflare R2' : 'Supabase Storage'}, and no ${backend === 'r2' ? 'R2' : 'Storage'} config is set to read it with.`);
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

export interface ObjectStoreOptions {
    /** Supabase Storage, when configured. */
    supabase?: MediaStorageConfig | null;
    /** Cloudflare R2, when configured. */
    r2?: R2Config | null;
    /** An R2 client to use instead of one built from `r2` — tests. */
    r2Client?: ObjectStorageClient | null;
    /**
     * Where NEW uploads go. Reads never look at this: a row's `storage_path` says where its bytes are (an `r2:` prefix is R2, anything else is
     * Supabase). Defaults to Supabase when it is given, else R2. `null`: nowhere here, so `put` stays in Postgres while this store still reads both.
     */
    writesTo?: 'supabase' | 'r2' | null;
}

/** Where new uploads go, from what the owner chose and what is configured. Pure, so the rule is testable. */
export function resolveWriteTarget(choice: 'supabase' | 'r2' | null, hasSupabase: boolean, hasR2: boolean): 'supabase' | 'r2' | null {
    if (choice === 'r2') return hasR2 ? 'r2' : hasSupabase ? 'supabase' : null;
    if (choice === 'supabase') return hasSupabase ? 'supabase' : null;
    return hasSupabase ? 'supabase' : hasR2 ? 'r2' : null;
}

/**
 * Bytes in object storage: the Supabase Storage bucket `media` at `<creatorId>/<id><ext>` and/or Cloudflare R2 at `r2:<creatorId>/<id><ext>`
 * (one private bucket for both public and private files); the row keeps the metadata with `data` NULL. Legacy rows are still served from `data`.
 * A private upload goes to Supabase's private bucket, or under `private/` in R2 (see the header): `target(path)` picks the client from the path.
 *
 * ONE store reads both, whichever backend takes new uploads: an existing file keeps working from where it lives. A row whose backend is not
 * configured is `MediaStorageUnavailableError` (503), as a Supabase row always was.
 */
export class ObjectMediaStore implements MediaStore {
    private readonly supabase: { client: SupabaseStorageClient; privateClient: SupabaseStorageClient } | null;
    private readonly r2: ObjectStorageClient | null;
    readonly writesTo: 'supabase' | 'r2' | null;
    private readonly postgres = new PostgresMediaStore();
    /** Checked once per instance, and instances are kept per config (`getMediaStore`). */
    private bucketReady: Promise<unknown> | null = null;
    private privateBucketReady: Promise<unknown> | null = null;

    constructor(options: ObjectStoreOptions) {
        const s = options.supabase ?? null;
        this.supabase = s ? {
            client: new SupabaseStorageClient({ url: s.url, key: s.key, bucket: MEDIA_BUCKET }),
            privateClient: new SupabaseStorageClient({ url: s.url, key: s.key, bucket: PRIVATE_MEDIA_BUCKET }),
        } : null;
        this.r2 = options.r2Client ?? (options.r2 ? new R2StorageClient(options.r2) : null);
        const wanted = options.writesTo === undefined ? (this.supabase ? 'supabase' : this.r2 ? 'r2' : null) : options.writesTo;
        // A write target that is not configured here is nowhere: never a silent switch of backend.
        this.writesTo = (wanted === 'supabase' && this.supabase) || (wanted === 'r2' && this.r2) ? wanted : null;
    }

    /** Whether this store can read and write that backend. */
    has(backend: 'supabase' | 'r2'): boolean {
        return backend === 'r2' ? this.r2 !== null : this.supabase !== null;
    }

    /** The client and key of the backend this path lives in. `mediaId` only names the upload in the error. */
    private target(path: string, mediaId = '?'): { client: ObjectStorageClient; key: string; backend: 'supabase' | 'r2' } {
        if (isR2Path(path)) {
            if (!this.r2) throw new MediaStorageUnavailableError(mediaId, 'r2');
            return { client: this.r2, key: r2KeyOf(path), backend: 'r2' };
        }
        if (!this.supabase) throw new MediaStorageUnavailableError(mediaId, 'supabase');
        return { client: bucketForPath(path) === PRIVATE_MEDIA_BUCKET ? this.supabase.privateClient : this.supabase.client, key: path, backend: 'supabase' };
    }

    /**
     * The `storage_path` a NEW upload gets in the backend that takes new uploads (`r2:` in front for R2). For the callers that sign an upload
     * and write the row themselves. Throws when no object store takes new uploads here: they check `writesTo` first for their own message.
     */
    newObjectPath(creatorId: string | null, id: string, mimeType: string, options: { private?: boolean } = {}): string {
        if (!this.writesTo) throw new Error('No object store takes new uploads here.');
        return `${this.writesTo === 'r2' ? R2_PATH_PREFIX : ''}${objectPathFor(creatorId, id, mimeType, options)}`;
    }

    /**
     * A URL the bytes of `path` can be PUT to without the backend's key. For R2 the declared size is first checked against the storage limit
     * (`R2LimitError`), and the signing counts as one Class A operation: the PUT is not ours to count.
     */
    async signUpload(path: string, mimeType: string, sizeBytes: number): Promise<SignedUpload> {
        const t = this.target(path);
        if (t.backend === 'r2') await assertR2Room(sizeBytes);
        return t.client.createSignedUploadUrl(t.key, mimeType);
    }

    /** What is actually stored at `path` (length and type), or null: how a signed upload is checked against what was declared. */
    headStored(path: string): Promise<{ size: number | null; contentType: string | null } | null> {
        const t = this.target(path);
        return t.client.headObject(t.key);
    }

    /** Whether this path's backend is one this store can reach. */
    canReach(path: string): boolean {
        return isR2Path(path) ? this.r2 !== null : this.supabase !== null;
    }

    /**
     * Creates the private bucket `media-private` the first time this instance needs it, with `public: false`, exactly as `ensureBucket`
     * does for `media`, and checks what is there: a bucket that exists and is public is refused (`PrivateBucketIsPublicError`), on every call
     * until it is fixed. Only a bucket seen to be private is remembered.
     */
    private ensurePrivateBucket(): Promise<unknown> {
        this.privateBucketReady ??= this.supabase!.privateClient.ensureBucket({ public: false }).then((outcome) => {
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
        this.bucketReady ??= this.supabase!.client.ensureBucket().then((outcome) => {
            if (outcome.created) log('info', 'media.bucket_created', { bucket: MEDIA_BUCKET });
            return outcome;
        }).catch((err) => {
            this.bucketReady = null; // try again on the next upload rather than failing forever
            throw err;
        });
        return this.bucketReady;
    }

    async put(input: PutMediaInput): Promise<{ id: string }> {
        if (!this.writesTo) return this.postgres.put(input);
        // The id is made here, not by Postgres, because the object is written first and its path
        // carries the id. Same uuid shape as ever, so the URL is unchanged.
        const id = randomUUID();
        const path = this.newObjectPath(input.creatorId, id, input.mimeType, { private: input.private === true });
        const backend = this.writesTo;
        const t = this.target(path, id);

        if (backend === 'r2') {
            // Over the free tier it is not written at all (`R2LimitError`); the upload itself counts as one Class A.
            await assertR2Room(input.data.length);
        } else if (input.private) {
            // A customer's file goes to the private bucket and ONLY there; a post's media to `media`, as it always did.
            await this.ensurePrivateBucket();
        } else {
            await this.ensureBucket();
        }
        await t.client.upload(t.key, input.data, input.mimeType);

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
            backend,
            ...(input.private ? { private: true } : {}),
        });
        return { id: row.id };
    }

    /** The object was written but its row was not: nothing will ever name it, so take it back out. */
    private async discard(path: string): Promise<void> {
        try {
            const t = this.target(path);
            await t.client.remove([t.key]);
        } catch (err) {
            log('error', 'media.orphan_object', { storage_path: path, message: (err as Error)?.message });
        }
    }

    async get(id: string, options: GetOptions = {}): Promise<StoredMedia | null> {
        const row = await locate(id, 'storage');
        if (!row || !mayRead(row, options.privateFor)) return null;
        if (!row.storage_path) return row.data ? { id, mimeType: row.mime_type, data: row.data } : null;

        const t = this.target(row.storage_path, id);
        const data = await t.client.download(t.key);
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

        const asked = parseByteRange(options.range, recorded);
        if (asked.kind === 'unsatisfiable') return { kind: 'unsatisfiable', id, mimeType: row.mime_type, total: asked.total };
        const wanted = asked.kind === 'range' ? asked : undefined;

        const t = this.target(row.storage_path, id);
        const object = await t.client.openStream(t.key, wanted);
        if (!object) {
            // The row says the object exists and Storage says it does not. Nothing the caller can
            // do about it, so a 404 — but loudly, because it means a file was lost.
            log('error', 'media.object_missing', { media_id: id, storage_path: row.storage_path });
            return null;
        }
        if (wanted && object.partial) {
            const length = wanted.end - wanted.start + 1;
            if (object.length !== null && object.length !== length) {
                // The store sent a slice of another length than asked: the recorded size is stale. Say so; trust what is sent.
                log('warn', 'media.range_mismatch', { media_id: id, asked_bytes: length, stored_bytes: object.length });
            }
            return {
                kind: 'stream', id, mimeType: row.mime_type, size: object.length ?? length, body: object.body,
                range: { start: wanted.start, end: object.length !== null ? wanted.start + object.length - 1 : wanted.end, total: wanted.total },
            };
        }
        if (recorded !== null && object.length !== null && recorded !== object.length) {
            log('warn', 'media.size_mismatch', { media_id: id, recorded_bytes: recorded, stored_bytes: object.length });
        }
        // What the store says it is sending wins: a Content-Length that disagrees with the body
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

/** A store with Supabase Storage only, as there was before R2: what a test or a script builds from one config. */
export class SupabaseStorageMediaStore extends ObjectMediaStore {
    constructor(readonly config: MediaStorageConfig) {
        super({ supabase: config, writesTo: 'supabase' });
    }
}

/**
 * The store when it takes object storage's side of a direct upload (a signed URL a browser or the Mac worker PUTs to), or null when new uploads here
 * go to Postgres: there is nothing to sign against. The callers answer 409 with "Large uploads need Supabase Storage or Cloudflare R2".
 */
export function directUploadStore(store: MediaStore): ObjectMediaStore | null {
    return store instanceof ObjectMediaStore && store.writesTo !== null ? store : null;
}

/** The store when it can reach object storage at all (to check what a signed upload delivered), else null. */
export function objectStoreOf(store: MediaStore): ObjectMediaStore | null {
    return store instanceof ObjectMediaStore ? store : null;
}

/** The sentence for a caller that wants a direct upload and cannot have one. */
export const NO_DIRECT_UPLOAD_MESSAGE = 'Large uploads need Supabase Storage or Cloudflare R2, and media here is not stored in either. Set one up in Settings → Media storage.';

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
let objectStore: { signature: string; store: ObjectMediaStore } | null = null;
let storeOverride: MediaStore | null = null;

/**
 * The store new uploads go to, which also reads every file wherever it lives: Supabase Storage and/or Cloudflare R2 when the operator has configured
 * them (Settings first, then `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` for Supabase), Postgres otherwise. Which one takes NEW uploads is the
 * owner's choice (`storage.backend`, `resolveWriteTarget`).
 *
 * Read on every call, like the Gemini key: a config saved in Settings has to reach every warm instance at once, and it is ONE indexed read
 * (`getMediaConfigs`). The instance is kept while the config is unchanged, so its bucket check happens once.
 */
export async function getMediaStore(): Promise<MediaStore> {
    if (storeOverride) return storeOverride;
    const { supabase, r2, choice } = await getMediaConfigs();
    if (!supabase && !r2) return postgresStore;
    const writesTo = resolveWriteTarget(choice, Boolean(supabase), Boolean(r2));
    const signature = JSON.stringify([supabase?.url, supabase?.key, r2?.accountId, r2?.bucket, r2?.accessKeyId, r2?.secretAccessKey, writesTo]);
    if (!objectStore || objectStore.signature !== signature) {
        objectStore = { signature, store: new ObjectMediaStore({ supabase, r2, writesTo }) };
    }
    return objectStore.store;
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

    let supabase: MediaStorageConfig | null;
    let r2: R2Config | null;
    try {
        ({ supabase, r2 } = await getMediaConfigs());
    } catch (err) {
        log('error', 'media.object_queue_unreadable', describeError(err));
        return { removed: 0, failed: 0, skipped: true, reason: 'error' };
    }
    if (!supabase && !r2) {
        log('warn', 'media.objects_waiting', { waiting: paths.length, reason: 'storage_unconfigured' });
        return { removed: 0, failed: 0, skipped: true, reason: 'unconfigured', waiting: paths.length };
    }

    // The queue holds paths and nothing else, so the backend is read off each path: `r2:…` is Cloudflare R2's, `private/…` Supabase's private
    // bucket, the rest its public one. One request per bucket; a bucket that fails keeps its entries and does not hold back the others. A backend
    // that is not configured here leaves its entries waiting (not counted as a failure: nothing was tried).
    const byBucket = new Map<string, string[]>();
    for (const path of paths) {
        const bucket = bucketForPath(path);
        byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), path]);
    }

    const removed: string[] = [];
    let failed = 0;
    for (const [bucket, group] of byBucket) {
        const isR2 = bucket === R2_BUCKET_TOKEN;
        if (isR2 ? !r2 : !supabase) {
            log('warn', 'media.objects_waiting', { waiting: group.length, reason: isR2 ? 'r2_unconfigured' : 'storage_unconfigured' });
            continue;
        }
        try {
            if (isR2) await new R2StorageClient(r2!).remove(group.map(r2KeyOf));
            else await new SupabaseStorageClient({ url: supabase!.url, key: supabase!.key, bucket }).remove(group);
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
    /** Rows whose bytes are an object in Supabase Storage, and what they add up to. */
    storage: { files: number; bytes: number };
    /** Rows whose bytes are an object in Cloudflare R2 (`storage_path` starts `r2:`), and what they add up to. */
    r2: { files: number; bytes: number };
    /** Rows whose bytes are still in `media_uploads.data`. The backfill moves them. */
    database: { files: number; bytes: number };
    /** Objects of deleted rows not yet removed from Storage. */
    queuedDeletions: number;
    tierBytes: number;
}

export async function getMediaUsage(): Promise<MediaUsage> {
    const row = await queryOne<{
        storage_files: string; storage_bytes: string; database_files: string; database_bytes: string; queued: string;
        r2_files?: string; r2_bytes?: string;
    }>(
        `SELECT count(*) FILTER (WHERE storage_path IS NOT NULL AND storage_path NOT LIKE 'r2:%')                       AS storage_files,
                COALESCE(sum(size_bytes) FILTER (WHERE storage_path IS NOT NULL AND storage_path NOT LIKE 'r2:%'), 0)   AS storage_bytes,
                count(*) FILTER (WHERE storage_path LIKE 'r2:%')                                                       AS r2_files,
                COALESCE(sum(size_bytes) FILTER (WHERE storage_path LIKE 'r2:%'), 0)                                   AS r2_bytes,
                count(*) FILTER (WHERE data IS NOT NULL)                                                               AS database_files,
                COALESCE(sum(octet_length(data)), 0)                                                                   AS database_bytes,
                (SELECT count(*) FROM media_object_deletions)                                                          AS queued
           FROM media_uploads`
    );
    const n = (value: string | undefined) => Number(value ?? 0) || 0;
    return {
        storage: { files: n(row?.storage_files), bytes: n(row?.storage_bytes) },
        r2: { files: n(row?.r2_files), bytes: n(row?.r2_bytes) },
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

export type R2Check =
    | {
        ok: true; bucketExists: boolean; created: boolean;
        /** `ok`: the rules already allow the app's origin; `set`: this check set them; `refused`: the token may not set them (say so, do not fail); `unchecked`: not asked. */
        cors: 'ok' | 'set' | 'refused' | 'unchecked'; corsError?: string;
    }
    /** 400: Cloudflare refused the key. 409: a free-tier limit is reached. 502: Cloudflare could not be asked. */
    | { ok: false; status: 400 | 409 | 502; error: string };

/**
 * Ask Cloudflare whether this R2 config works: read the bucket (Class B), and with `create` also create it if missing and make sure the browser's direct upload
 * is allowed by the bucket's CORS rules for `origins`. What Settings runs before saving, so a wrong key is never saved. A token that may not set CORS
 * (an "Object Read & Write" token cannot) is NOT a failure: uploads from the server work without it, so the answer carries `cors: 'refused'` and the card says
 * to add the rule in Cloudflare. Every request is counted against the free tier (`R2StorageClient`); one that would pass it is `409`.
 */
export async function checkR2Storage(
    config: R2Config, options: { create?: boolean; origins?: readonly string[]; client?: ObjectStorageClient & { ensureCors?: (origins: readonly string[]) => Promise<unknown> } } = {}
): Promise<R2Check> {
    const client = options.client ?? new R2StorageClient(config);
    try {
        if (!options.create) {
            const bucket = await client.getBucket();
            return { ok: true, bucketExists: Boolean(bucket), created: false, cors: 'unchecked' };
        }
        const outcome = await client.ensureBucket();
        let cors: 'ok' | 'set' | 'refused' | 'unchecked' = 'unchecked';
        let corsError: string | undefined;
        if (options.origins && options.origins.length > 0 && client.ensureCors) {
            try {
                const done = await client.ensureCors(options.origins) as { changed?: boolean };
                cors = done.changed ? 'set' : 'ok';
            } catch (err) {
                if (err instanceof StorageApiError && err.refused) {
                    cors = 'refused';
                    corsError = err.message;
                } else {
                    throw err;
                }
            }
        }
        return { ok: true, bucketExists: true, created: outcome.created, cors, ...(corsError ? { corsError } : {}) };
    } catch (err) {
        if (err instanceof R2LimitError) return { ok: false, status: 409, error: err.message };
        if (err instanceof StorageApiError && !err.unreachable && err.status < 500) {
            return { ok: false, status: 400, error: err.message };
        }
        return { ok: false, status: 502, error: (err as Error)?.message ?? 'Could not reach Cloudflare R2.' };
    }
}

export interface MediaStorageStatus {
    /** Where new uploads go right now. */
    backend: 'supabase' | 'r2' | 'postgres';
    /** What the owner chose (`storage.backend`), or null when nothing was chosen. */
    choice: 'supabase' | 'r2' | null;
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
    /** Cloudflare R2: what is saved (never the secret), its live status, this month's use against the limits, and the copy job. */
    r2: {
        configured: boolean;
        accountId: string | null;
        bucket: string;
        accessKeyId: { set: boolean; preview: string | null };
        secretAccessKey: { set: boolean; preview: string | null };
        connection: R2Check | null;
        summary: R2UsageSummary | null;
        summaryError?: string;
        copy: R2CopyStatus | null;
        /**
         * The bucket's CORS rules, which only the browser's direct upload of ad media needs. `status` is what the last save learned (`refused`: the token may not set
         * them, so the owner pastes `policy` in Cloudflare: R2 → the bucket → Settings → CORS Policy). `policy` is null when the app has no public address yet.
         */
        cors: { status: 'ok' | 'set' | 'refused' | null; origin: string | null; policy: string | null };
    };
}

/** Everything the Settings card shows, including a live round trip to Supabase and to R2. Never a key. */
export async function describeMediaStorage(options: { origin?: string | null } = {}): Promise<MediaStorageStatus> {
    const [config, savedUrl, savedKey, configs, r2Saved, corsSaved, publicBase] = await Promise.all([
        getMediaStorageConfig(),
        getSetting(APP_SETTING_KEYS.mediaStorageUrl),
        getSetting(APP_SETTING_KEYS.mediaStorageKey),
        getMediaConfigs(),
        getSettings([APP_SETTING_KEYS.r2AccountId, APP_SETTING_KEYS.r2Bucket, APP_SETTING_KEYS.r2AccessKeyId, APP_SETTING_KEYS.r2SecretAccessKey]),
        getSetting(APP_SETTING_KEYS.r2Cors),
        getPublicBaseUrl(options.origin ?? null),
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

    const writesTo = resolveWriteTarget(configs.choice, Boolean(configs.supabase), Boolean(configs.r2));
    const savedAccessKeyId = r2Saved.get(APP_SETTING_KEYS.r2AccessKeyId) ?? null;
    const savedSecret = r2Saved.get(APP_SETTING_KEYS.r2SecretAccessKey) ?? null;
    let summary: R2UsageSummary | null = null;
    let summaryError: string | undefined;
    let copy: R2CopyStatus | null = null;
    if (configs.r2) {
        try {
            summary = await readR2Summary();
        } catch (err) {
            summaryError = (err as Error)?.message ?? 'Could not read the R2 usage.';
        }
        copy = await readCopyStatus().catch(() => null);
    }

    return {
        backend: writesTo ?? 'postgres',
        choice: configs.choice,
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
        r2: {
            configured: Boolean(configs.r2),
            accountId: r2Saved.get(APP_SETTING_KEYS.r2AccountId) ?? null,
            bucket: r2Saved.get(APP_SETTING_KEYS.r2Bucket) ?? DEFAULT_R2_BUCKET,
            accessKeyId: { set: Boolean(savedAccessKeyId), preview: savedAccessKeyId ? maskValue(savedAccessKeyId) : null },
            secretAccessKey: { set: Boolean(savedSecret), preview: savedSecret ? maskValue(savedSecret) : null },
            connection: configs.r2 ? await checkR2Storage(configs.r2) : null,
            summary,
            ...(summaryError ? { summaryError } : {}),
            copy,
            cors: {
                status: corsSaved === 'ok' || corsSaved === 'set' || corsSaved === 'refused' ? corsSaved : null,
                origin: publicBase,
                policy: publicBase ? r2CorsPolicy(publicBase) : null,
            },
        },
    };
}
