/**
 * `[SPLIT]` templates.
 *
 * The rule that shapes all of this is Meta's: **one private reply per comment, ever.** So a
 * three-part template is one irreversible send followed by two ordinary DMs, and the pipeline
 * has to treat them differently. It did not: the interaction was marked SENT only after the
 * whole loop, so part 3 failing marked the row FAILED even though the recipient already had
 * parts 1 and 2 — and a retry of that row re-sent the private reply, which Meta refuses, so
 * the retry could only ever fail.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitDmTemplate } from './comments.js';

describe('splitDmTemplate', () => {
    it('leaves a template with no marker as a single message', () => {
        assert.deepEqual(splitDmTemplate('مرحبا بك'), { first: 'مرحبا بك', followUps: [] });
    });

    it('splits on the marker and trims each part', () => {
        assert.deepEqual(splitDmTemplate('أهلا [SPLIT] هذا الرابط [SPLIT] شكرا'), {
            first: 'أهلا',
            followUps: ['هذا الرابط', 'شكرا'],
        });
    });

    it('drops empty parts rather than sending a blank message', () => {
        // A template ending in the marker, or carrying two in a row, otherwise produced a
        // send Meta rejects with "param message must be a non-empty object".
        assert.deepEqual(splitDmTemplate('أهلا [SPLIT]'), { first: 'أهلا', followUps: [] });
        assert.deepEqual(splitDmTemplate('أهلا [SPLIT] [SPLIT] شكرا'), {
            first: 'أهلا',
            followUps: ['شكرا'],
        });
        assert.deepEqual(splitDmTemplate('[SPLIT] أهلا'), { first: 'أهلا', followUps: [] });
    });

    it('keeps the first part identifiable even for an all-whitespace template', () => {
        // Nothing usable to send. Falling back to the original keeps the failure where it was
        // — one rejected send with a Meta error that names the empty message — rather than
        // turning it into a silent no-op indistinguishable from success.
        const result = splitDmTemplate('   ');
        assert.equal(result.first, '   ');
        assert.deepEqual(result.followUps, []);
    });

    it('trims a plain template too', () => {
        assert.deepEqual(splitDmTemplate('  مرحبا  '), { first: 'مرحبا', followUps: [] });
    });

    it('preserves newlines inside a part', () => {
        // Templates are written with line breaks for readability; only the outer edges are
        // trimmed.
        const { first } = splitDmTemplate('السلام عليكم\nتفضل الرابط [SPLIT] شكرا');
        assert.equal(first, 'السلام عليكم\nتفضل الرابط');
    });
});
