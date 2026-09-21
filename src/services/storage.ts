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
import { queryOne } from '../db/query.js';
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

    publicUrl(id: string, origin: string): string {
        return `${origin}/api/uploads/${id}`;
    }
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
