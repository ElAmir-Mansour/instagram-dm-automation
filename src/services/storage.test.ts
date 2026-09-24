/**
 * The media storage seam.
 *
 * What is worth asserting without a database is the contract the two call sites depend on,
 * because that contract is the whole reason the interface exists: if a second implementation
 * can satisfy it, moving the bytes out of Postgres is a one-line change to `getMediaStore`.
 *
 * The URL shape in particular is load-bearing and easy to break silently. Meta cURLs it
 * during ingestion, so a malformed URL surfaces days later as a scheduled post failing to
 * publish with an opaque Meta error, not as anything resembling a storage bug.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    PostgresMediaStore, getMediaStore, setMediaStore, uploadIdFromSegment, uploadIdFromUrl, type MediaStore,
} from './storage.js';

describe('PostgresMediaStore.publicUrl', () => {
    const store = new PostgresMediaStore();

    it('builds the URL /api/uploads/:id against the request origin', () => {
        assert.equal(
            store.publicUrl('abc-123', 'https://msg-response-auto.vercel.app'),
            'https://msg-response-auto.vercel.app/api/uploads/abc-123'
        );
    });

    it('preserves the scheme it is given', () => {
        // The caller derives this from x-forwarded-proto; hardcoding https here would break
        // local development, and hardcoding http would hand Meta a URL it may refuse.
        assert.equal(store.publicUrl('id', 'http://localhost:3000'), 'http://localhost:3000/api/uploads/id');
    });
});

describe('getMediaStore', () => {
    it('returns the Postgres implementation by default', () => {
        const previous = setMediaStore(null);
        try {
            assert.ok(getMediaStore() instanceof PostgresMediaStore);
        } finally {
            setMediaStore(previous);
        }
    });

    it('returns the same instance on repeated calls', () => {
        const previous = setMediaStore(null);
        try {
            assert.equal(getMediaStore(), getMediaStore());
        } finally {
            setMediaStore(previous);
        }
    });

    it('accepts a substitute implementation — this is the migration path', () => {
        // Stands in for the Vercel Blob / R2 store. If this compiles and the call sites keep
        // working, moving media out of Postgres does not touch any route.
        const puts: string[] = [];
        const fake: MediaStore = {
            async put(input) {
                puts.push(input.filename);
                return { id: 'blob-1' };
            },
            async get() {
                return null;
            },
            async mimeTypes() {
                return new Map();
            },
            publicUrl(id) {
                return `https://cdn.example.com/${id}`;
            },
        };

        const previous = setMediaStore(fake);
        try {
            assert.equal(getMediaStore(), fake);
            assert.equal(getMediaStore().publicUrl('blob-1', 'https://ignored.example'), 'https://cdn.example.com/blob-1');
        } finally {
            setMediaStore(previous);
        }
    });

    it('lets a substitute ignore the origin entirely', async () => {
        const fake: MediaStore = {
            async put() { return { id: 'x' }; },
            async get() { return { id: 'x', mimeType: 'video/mp4', data: Buffer.from('hi') }; },
            async mimeTypes() { return new Map([['x', 'video/mp4']]); },
            publicUrl(id) { return `https://bucket.r2.dev/${id}`; },
        };

        const previous = setMediaStore(fake);
        try {
            const media = await getMediaStore().get('x');
            assert.equal(media?.mimeType, 'video/mp4');
            assert.deepEqual(media?.data, Buffer.from('hi'));
        } finally {
            setMediaStore(previous);
        }
    });
});

describe('our upload URLs, with and without an extension', () => {
    const id = '0b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';

    it('reads the id out of the route segment, extension or not', () => {
        // TikTok's photo fetcher is sent `<uuid>.jpg`, and Express 5 hands the route the whole
        // segment — without this the extension turned every photo fetch into a 404.
        assert.equal(uploadIdFromSegment(id), id);
        for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'mp4', 'JPG']) {
            assert.equal(uploadIdFromSegment(`${id}.${ext}`), id, ext);
        }
        assert.equal(uploadIdFromSegment(id.toUpperCase()), id);
    });

    it('still refuses anything that is not a bare uuid plus a known extension', () => {
        // Postgres answers a malformed uuid literal with 22P02, which surfaced as a 500.
        for (const bad of [`${id}.html`, `${id}.jpg.jpg`, `${id}x`, 'not-a-uuid.jpg', '', `../${id}`]) {
            assert.equal(uploadIdFromSegment(bad), null, bad);
        }
        assert.equal(uploadIdFromSegment(undefined), null);
    });

    it('recognises our upload URLs on any host, extension or not', () => {
        assert.equal(uploadIdFromUrl(`https://msg-response-auto.vercel.app/api/uploads/${id}.jpg`), id);
        assert.equal(uploadIdFromUrl(`https://preview-abc.vercel.app/api/uploads/${id}.webp?v=2`), id);
        assert.equal(uploadIdFromUrl(`http://localhost:3000/api/uploads/${id}`), id);
        assert.equal(uploadIdFromUrl(`https://cdn.example/api/uploads/${id}.gif`), null);
        assert.equal(uploadIdFromUrl('https://cdn.example/photo.jpg'), null);
    });
});
