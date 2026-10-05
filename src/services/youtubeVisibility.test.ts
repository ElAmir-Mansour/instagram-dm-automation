/**
 * The daily visibility check's rules: which Shorts get a sentence, and how today's replaces
 * yesterday's without touching the upload's own notes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeVisibilityNote, visibilityNote } from './youtubeVisibility.js';

describe('visibilityNote', () => {
    const day = '2026-10-07';
    it('nothing to say about a public Short, or a private one when private was what was asked', () => {
        assert.equal(visibilityNote({ privacy: 'public', uploadStatus: 'processed' }, true, day), null);
        assert.equal(visibilityNote({ privacy: 'private', uploadStatus: 'processed' }, false, day), null);
    });
    it('says when YouTube made a Short private, removed it, or rejected the upload', () => {
        assert.match(visibilityNote({ privacy: 'private', uploadStatus: 'processed' }, true, day)!, /^Visibility check 2026-10-07: YouTube now shows this Short as private/);
        assert.match(visibilityNote(undefined, true, day)!, /no longer has this video/);
        assert.match(visibilityNote({ privacy: 'public', uploadStatus: 'rejected' }, true, day)!, /as rejected/);
    });
});

describe('mergeVisibilityNote', () => {
    it('replaces yesterday’s sentence, keeps the upload’s own note, clears to null when nothing is left', () => {
        const thumb = 'Thumbnail not set: forbidden.';
        const old = `${thumb} Visibility check 2026-10-06: YouTube now shows this Short as private — make it public in YouTube Studio.`;
        assert.equal(mergeVisibilityNote(old, null), thumb);
        assert.equal(mergeVisibilityNote(old, 'Visibility check 2026-10-07: x.'), `${thumb} Visibility check 2026-10-07: x.`);
        assert.equal(mergeVisibilityNote('Visibility check 2026-10-06: y.', null), null);
        assert.equal(mergeVisibilityNote(null, null), null);
    });
});
