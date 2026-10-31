/**
 * How a thing was looked at, as words (`how.ts`): the sentence a description starts with and the phrase a trace starts with. What matters is that they AGREE, since the
 * trace reads the way back out of the description (`Perception` has no field for it): a reel read by its caption is never said to have been watched, in either place.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HOW_PREFIX, howOf, readNoun, readPhrase, withHow, type HowSeen } from './how.js';
import { PERCEIVABLE_KINDS } from './types.js';

describe('withHow and howOf: the sentence in front of a description, and back', () => {
    const ways: HowSeen[] = ['watched', 'library', 'cover', 'caption', 'media'];

    it('names each way in front of the description, and says nothing in front of what was shown whole', () => {
        assert.equal(withHow('watched', 'A reel.', true), 'Watched the reel. A reel.');
        assert.equal(withHow('library', 'A reel.', false), 'Watched the reel earlier (the library\'s notes on it). A reel.');
        assert.equal(withHow('cover', 'A cover.', true), 'Saw the cover and caption. A cover.');
        assert.equal(withHow('cover', 'A cover.', false), 'Saw the cover. A cover.');
        assert.equal(withHow('caption', 'It says: «x»', true), 'Read the caption. It says: «x»');
        assert.equal(withHow('media', 'A photo.', false), 'A photo.');
        assert.deepEqual(Object.keys(HOW_PREFIX).sort(), [...ways].sort());
    });

    it('reads the way back out of what it wrote: every way, the cover with and without a caption', () => {
        for (const how of ways.filter((w) => w !== 'cover')) assert.deepEqual(howOf(withHow(how, 'x', true)), { how, captioned: false }, how);
        assert.deepEqual(howOf(withHow('cover', 'x', true)), { how: 'cover', captioned: true });
        assert.deepEqual(howOf(withHow('cover', 'x', false)), { how: 'cover', captioned: false });
    });

    it('a description that starts with none of them was shown whole, and so is no description at all', () => {
        for (const seen of ['A photo of a price list.', '', undefined, 'watched the reel.', 'Read the caption of something']) assert.deepEqual(howOf(seen), { how: 'media', captioned: false }, String(seen));
    });

    it('is one clean line and bounded', () => {
        assert.ok(!/\n/.test(withHow('watched', 'a\nb', true)));
        assert.ok([...withHow('watched', 'x'.repeat(3000), true)].length <= 600);
    });
});

describe('readPhrase: how a trace begins', () => {
    it('says what really happened, for what was read', () => {
        assert.equal(readPhrase('reel', withHow('watched', 'x', true)), 'Watched a shared reel');
        assert.equal(readPhrase('reel', withHow('library', 'x', false)), 'Used the library\'s notes on a shared reel');
        assert.equal(readPhrase('reel', withHow('caption', 'x', true)), 'Read the caption of a shared reel');
        assert.equal(readPhrase('share', withHow('cover', 'x', true)), 'Saw the cover of a shared post and its caption');
        assert.equal(readPhrase('share', withHow('cover', 'x', false)), 'Saw the cover of a shared post');
        assert.equal(readPhrase('image', 'A photo of a price list.'), 'Read a photo');
        assert.equal(readPhrase('story_reply', undefined), 'Read a reply to the account\'s story');
    });

    it('says a voice note was HEARD: it is listened to, and nothing about how it was looked at applies, whatever the stored text starts with', () => {
        assert.equal(readPhrase('audio', undefined), 'Heard a voice note');
        assert.equal(readPhrase('audio', 'Watched the reel. x'), 'Heard a voice note');
        assert.equal(readNoun('audio'), 'a voice note');
    });

    it('has a noun for every kind perception reads, and the trace and the description agree on them', () => {
        for (const kind of PERCEIVABLE_KINDS) assert.ok(readNoun(kind).length > 0, kind);
        assert.equal(readNoun('reel'), 'a shared reel');
        assert.equal(readNoun('story_mention'), 'a story mention');
    });
});
