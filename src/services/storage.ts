/**
 * Media storage.
 *
 * Today this is a BYTEA column. That is the wrong place for video and everyone involved
 * knows it: `media_uploads` is already ~40MB against a 500MB Supabase tier, it grows with
 * every reel, and the bytes travel over the Postgres connection twice — once on upload, once
 * on every fetch Meta makes when it ingests the media. A 1080x1920 reel is ~15-30MB; a few
 * dozen of them is the whole tier.
 *
 * The reason it has not moved is that "move to Blob/R2" reads as a big change, when in fact
 * the storage decision is reachable from exactly two call sites (POST /api/upload and
 * GET /api/uploads/:id). This interface is the seam that makes that true in the type system
 * rather than only in practice, so the migration becomes: write `BlobMediaStore`, flip
 * `getMediaStore`, backfill. See ADR-3 in ARCHITECTURE.md.
 *
 * The one constraint any implementation must honour: `publicUrl` has to be fetchable by Meta
 * without credentials. Meta cURLs the URL itself during ingestion — it is not a browser and
 * it carries no session — so a signed short-lived URL is fine but a private bucket is not.
 */
import { queryOne, queryRows } from '../db/query.js';
import { log } from '../utils/log.js';
import type { MediaUploadRow } from '../db/rows.js';

export interface PutMediaInput {
    creatorId: string;
    filename: string;
    mimeType: string;
    data: Buffer;
}

export interface StoredMedia {
    id: string;
    mimeType: string;
    data: Buffer;
}

export interface MediaStore {
    /** Store bytes and return the id the public URL is built from. */
    put(input: PutMediaInput): Promise<{ id: string }>;
    /** Fetch by id, or null when it does not exist. */
    get(id: string): Promise<StoredMedia | null>;
    /**
     * What each id is stored as, without reading its bytes — validating a 35-photo carousel
     * must not pull 35 files over the Postgres connection. Ids that do not exist are absent.
     */
    mimeTypes(ids: readonly string[]): Promise<Map<string, string>>;
    /**
     * The URL Meta will fetch. Takes the request origin because this deployment's own
     * hostname is the only thing serving the Postgres-backed implementation; an object-store
     * implementation ignores it and returns the bucket's URL.
     */
    publicUrl(id: string, origin: string): string;
}

/**
 * The current implementation: bytes in Postgres, served back by `/api/uploads/:id`.
 *
 * Kept deliberately faithful to what shipped, including serving from this origin, so that
 * introducing the interface changes nothing observable.
 */
export class PostgresMediaStore implements MediaStore {
    async put(input: PutMediaInput): Promise<{ id: string }> {
        const row = await queryOne<Pick<MediaUploadRow, 'id'>>(
            `INSERT INTO media_uploads (creator_id, filename, mime_type, data)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [input.creatorId, input.filename, input.mimeType, input.data]
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
        });
        return { id: row.id };
    }

    async get(id: string): Promise<StoredMedia | null> {
        const row = await queryOne<Pick<MediaUploadRow, 'mime_type' | 'data'>>(
            'SELECT mime_type, data FROM media_uploads WHERE id = $1',
            [id]
        );
        if (!row) return null;
        return { id, mimeType: row.mime_type, data: row.data };
    }

    async mimeTypes(ids: readonly string[]): Promise<Map<string, string>> {
        if (ids.length === 0) return new Map();
        const rows = await queryRows<Pick<MediaUploadRow, 'id' | 'mime_type'>>(
            'SELECT id, mime_type FROM media_uploads WHERE id = ANY($1::uuid[])',
            [[...ids]]
        );
        return new Map(rows.map((row) => [String(row.id).toLowerCase(), row.mime_type]));
    }

    publicUrl(id: string, origin: string): string {
        return `${origin}/api/uploads/${id}`;
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

let storeInstance: MediaStore | null = null;

/**
 * The store this process uses.
 *
 * A function rather than a constant so the backend can be selected from the environment
 * (`MEDIA_STORE=blob`) when a second implementation exists, without any call site changing.
 */
export function getMediaStore(): MediaStore {
    storeInstance ??= new PostgresMediaStore();
    return storeInstance;
}

/** Override the store — tests only. Returns the previous instance. */
export function setMediaStore(next: MediaStore | null): MediaStore | null {
    const previous = storeInstance;
    storeInstance = next;
    return previous;
}
