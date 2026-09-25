/**
 * The Instagram reach levers at create/edit time (`validateMetaOptions`) and at publish time
 * (`reachOptionsFor`), and the note a PUBLISHED row keeps when Instagram refused one.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { droppedLeversNote, reachOptionsFor, sendsMetaOptions, validateMetaOptions } from './metaOptions.js';

const image = { platform: 'instagram', postType: 'image' };
const carousel = (slideCount: number) => ({ platform: 'both', postType: 'carousel', slideCount });
const reel = { platform: 'both', postType: 'video' };

describe('validateMetaOptions', () => {
    it('keeps an image’s alt text on one line, and refuses one over Instagram’s 1000', () => {
        const ok = validateMetaOptions({ alt_text: '  A prompt\n on a dark   slide ' }, image);
        assert.deepEqual(ok, { ok: true, options: { alt_text: 'A prompt on a dark slide' } });
        const long = validateMetaOptions({ alt_text: 'x'.repeat(1001) }, image);
        assert.deepEqual(long, { ok: false, error: 'The alt text is 1001 characters; Instagram takes at most 1000.' });
        assert.deepEqual(validateMetaOptions({ alt_text: 42 }, image), { ok: false, error: 'alt_text must be text.' });
    });

    it('aligns alt_texts with the slides: blanks are null, trailing blanks drop, more entries than slides is refused', () => {
        assert.deepEqual(validateMetaOptions({ alt_texts: ['one', '', null, 'four', ' '] }, carousel(5)),
            { ok: true, options: { alt_texts: ['one', null, null, 'four'] } });
        assert.deepEqual(validateMetaOptions({ alt_texts: ['a', 'b', 'c'] }, carousel(2)),
            { ok: false, error: 'alt_texts has 3 entries, but the carousel has 2 slides.' });
        const slide = validateMetaOptions({ alt_texts: ['ok', 'y'.repeat(1200)] }, carousel(2));
        assert.equal(slide.ok, false);
        assert.match((slide as { error: string }).error, /slide 2 is 1200 characters/);
    });

    it('takes up to 3 collaborators, without the @, in lower case, once each', () => {
        assert.deepEqual(validateMetaOptions({ collaborators: ['@Partner.One', 'partner.one', ' two_2 '] }, reel),
            { ok: true, options: { collaborators: ['partner.one', 'two_2'] } });
        assert.deepEqual(validateMetaOptions({ collaborators: ['a', 'b', 'c', 'd'] }, reel),
            { ok: false, error: 'Instagram takes at most 3 collaborators — this post has 4.' });
        const bad = validateMetaOptions({ collaborators: ['not a user!'] }, reel);
        assert.equal(bad.ok, false);
        assert.match((bad as { error: string }).error, /is not an Instagram username/);
        assert.equal(validateMetaOptions({ collaborators: 'a,b' }, reel).ok, false, 'a list, not a string');
    });

    it('takes a trial reel with MANUAL or SS_PERFORMANCE graduation, and null turns it off', () => {
        assert.deepEqual(validateMetaOptions({ trial_reel: { graduation: 'ss_performance' } }, reel),
            { ok: true, options: { trial_reel: { graduation: 'SS_PERFORMANCE' } } });
        assert.deepEqual(validateMetaOptions({ trial_reel: { graduation: 'SOON' } }, reel),
            { ok: false, error: 'trial_reel.graduation must be MANUAL or SS_PERFORMANCE.' });
        assert.deepEqual(validateMetaOptions({ trial_reel: null }, { ...reel, current: { trial_reel: { graduation: 'MANUAL' } } }),
            { ok: true, options: null });
    });

    it('drops a lever the post can’t use rather than refusing it', () => {
        // Instagram: alt text only on images, trial only on reels, collaborators never on stories.
        assert.deepEqual(validateMetaOptions({ alt_text: 'x', trial_reel: { graduation: 'MANUAL' } }, image),
            { ok: true, options: { alt_text: 'x' } });
        assert.deepEqual(validateMetaOptions({ collaborators: ['a'] }, { platform: 'instagram', postType: 'story' }), { ok: true, options: null });
        assert.deepEqual(validateMetaOptions({ alt_text: 'x', collaborators: ['a'] }, { platform: 'facebook', postType: 'image' }),
            { ok: true, options: null }, 'Facebook-only rows carry none');
    });

    it('merges an edit over what the row has: a field left out keeps its value', () => {
        const current = { collaborators: ['a'], trial_reel: { graduation: 'MANUAL' as const } };
        assert.deepEqual(validateMetaOptions({ collaborators: ['b'] }, { ...reel, current }),
            { ok: true, options: { collaborators: ['b'], trial_reel: { graduation: 'MANUAL' } } });
        assert.equal(sendsMetaOptions({ caption: 'x' }), false);
        assert.equal(sendsMetaOptions({ trial_reel: null }), true, 'null is sent: it clears');
    });
});

describe('reachOptionsFor', () => {
    const stored = { alt_text: 'img', alt_texts: ['s1', null], collaborators: ['a'], trial_reel: { graduation: 'MANUAL' as const } };

    it('sends only what fits the row as it is at publish time', () => {
        assert.deepEqual(reachOptionsFor('instagram', 'image', stored), { altText: 'img', collaborators: ['a'] });
        assert.deepEqual(reachOptionsFor('both', 'carousel', stored), { altTexts: ['s1', null], collaborators: ['a'] });
        assert.deepEqual(reachOptionsFor('both', 'video', stored), { collaborators: ['a'], trialReel: { graduation: 'MANUAL' } });
        assert.deepEqual(reachOptionsFor('instagram', 'story', stored), {});
        assert.deepEqual(reachOptionsFor('both', 'image', null), {});
    });
});

describe('droppedLeversNote', () => {
    it('says what went out without which lever, and why', () => {
        assert.equal(droppedLeversNote([]), null);
        assert.equal(
            droppedLeversNote([{ field: 'trial_params', reason: 'Unsupported for this account (Code: 100)' }]),
            'Published without the trial reel: Instagram refused it for this account — Unsupported for this account (Code: 100)',
        );
        assert.match(droppedLeversNote([{ field: 'alt_text', reason: 'r' }, { field: 'collaborators', reason: 'r' }])!,
            /^Published without alt text and collaborators: Instagram refused them/);
    });
});
