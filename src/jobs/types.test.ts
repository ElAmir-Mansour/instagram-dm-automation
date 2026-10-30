/**
 * The job-kind guard.
 *
 * Small, but it is the thing standing between "one row in `jobs` has a kind nobody
 * recognises" and "the drain throws on every pass and no tenant's work gets done". A rollback
 * that removes a handler while jobs of that kind are still queued is the realistic way to get
 * there.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BACKGROUND_JOB_KINDS, JOB_KINDS, isJobKind, isWhatsAppDmPayload } from './types.js';

describe('isJobKind', () => {
    it('accepts every kind in the registry', () => {
        for (const kind of JOB_KINDS) assert.equal(isJobKind(kind), true, kind);
    });

    it('rejects anything else, including near-misses', () => {
        for (const value of ['comment', 'comment.processs', 'COMMENT.PROCESS', 'dm', '']) {
            assert.equal(isJobKind(value), false, JSON.stringify(value));
        }
    });

    it('rejects non-strings rather than throwing on them', () => {
        // The value arrives from a JSONB column, so it is whatever is in the database.
        for (const value of [null, undefined, 42, {}, [], true]) {
            assert.equal(isJobKind(value), false, JSON.stringify(value) ?? 'undefined');
        }
    });

    it('does not treat inherited Array members as kinds', () => {
        // `includes` on the tuple, not `in` — guards against a value like 'length'.
        assert.equal(isJobKind('length'), false);
        assert.equal(isJobKind('0'), false);
    });
});

describe('the WhatsApp job kinds', () => {
    it('wa.event is a kind, so a job of that kind in the table is run and not refused', () => {
        assert.equal(isJobKind('wa.event'), true);
        assert.ok((JOB_KINDS as readonly string[]).includes('wa.event'));
    });

    it('a dm.process payload is WhatsApp’s only with the app’s own object name and a change: an Instagram one never is', () => {
        assert.equal(isWhatsAppDmPayload({ object: 'whatsapp', entryId: 'w', phoneNumberId: 'p', change: {} }), true);
        for (const payload of [
            { event: {}, entryId: 'p' },
            { event: {}, entryId: 'p', object: 'instagram' },
            { event: {}, entryId: 'p', object: 'page' },
            { event: {}, entryId: 'p', object: 'whatsapp_business_account' },
            { event: {}, entryId: 'p', object: 'whatsapp' },
        ]) {
            assert.equal(isWhatsAppDmPayload(payload), false, JSON.stringify(payload));
        }
    });
});

describe('the video memory\'s job kind', () => {
    it('muse.reel_index is a kind, so a job of that kind in the table is run and not refused as unknown', () => {
        assert.equal(isJobKind('muse.reel_index'), true);
        assert.ok((JOB_KINDS as readonly string[]).includes('muse.reel_index'));
        assert.equal(isJobKind('muse.reel_index.'), false);
        assert.equal(isJobKind('muse.offer_card'), false, 'the cut phases have no kind');
    });

    it('is the one background kind: slow work that no person is waiting on, which a drain runs after what a person is waiting for', () => {
        assert.deepEqual([...BACKGROUND_JOB_KINDS], ['muse.reel_index']);
        for (const kind of BACKGROUND_JOB_KINDS) assert.ok((JOB_KINDS as readonly string[]).includes(kind), kind);
    });
});
