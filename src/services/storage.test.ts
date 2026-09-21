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
import { PostgresMediaStore, getMediaStore, setMediaStore, type MediaStore } from './storage.js';

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
