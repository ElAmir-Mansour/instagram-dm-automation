/**
 * What the pipeline does with a perception (`plan.ts`): answer it with the sales turn, or send a line. Pure, so every outcome of the read is listed here, in the kit's words.
 *
 *   - a story mention is thanked by name when what it showed is fit to say back, and by the usual thanks when it is not; it is never answered by a sales turn;
 *   - what could not be read with confidence is asked for again only when the person SENT it: a story they replied to or mentioned the account in has nothing to resend;
 *   - every read that did not come to be (the link, the cap, the key, the time) is the usual line, with its reason as one sentence for the inbox;
 *   - a personal document is an answer that the sales turn hands to a person, never a description.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KITS } from '../profile/kits.js';
import { notReadReason, planOf } from './plan.js';
import { perceivedFact, perceivedText } from './text.js';
import { PERCEIVABLE_KINDS, type Perception, type PerceptionKind } from './types.js';

const base = (over: Partial<Perception> = {}): Perception => ({
    v: 1, kind: 'reel', status: 'ok', seen: 'A 37-second reel about a backend.', about_owner: 'own_content', confidence: 0.9, model: 'muse-spark-1.3', stored_at: '2026-10-30T10:00:00.000+00:00', ms: 4000, usd: 0.02, ...over,
});
const en = KITS.en.attachments;
const gulf = KITS.gulf.attachments;

describe('planOf: a perception that was read', () => {
    it('is answered by the sales turn: the stored text is the description, the fact is what it shows, and the prefilter will skip the description', () => {
        const p = base();
        const plan = planOf(p, en);
        assert.equal(plan.kind, 'answer');
        assert.ok(plan.kind === 'answer');
        assert.equal(plan.text, perceivedText('reel', p));
        assert.equal(plan.text, '[shared reel] A 37-second reel about a backend.');
        assert.deepEqual(plan.perceived, { kind: 'reel', describedText: true, sent: perceivedFact(p), read: 'Read a shared reel', personal: false });
        assert.match(plan.perceived.sent!, /^What the customer sent: a shared reel\. What it shows: A 37-second reel about a backend\./);
    });

    it('is the same for every kind a person can send or reply to, each in its own words', () => {
        for (const kind of PERCEIVABLE_KINDS.filter((k): k is Exclude<PerceptionKind, 'audio' | 'story_mention'> => k !== 'audio' && k !== 'story_mention')) {
            const plan = planOf(base({ kind }), en);
            assert.ok(plan.kind === 'answer', kind);
            assert.equal(plan.perceived.kind, kind);
            assert.equal(plan.perceived.describedText, true);
            assert.ok(plan.text.startsWith('['), kind);
        }
    });

    it('says how it was looked at, from the sentence the description starts with: a reel that was watched, one read by its caption, a cover', () => {
        const read = (seen: string, kind: 'reel' | 'share' = 'reel'): string | undefined => { const plan = planOf(base({ kind, seen }), en); return plan.kind === 'answer' ? plan.perceived.read : undefined; };
        assert.equal(read('Watched the reel. A reel about a backend.'), 'Watched a shared reel');
        assert.equal(read('Watched the reel earlier (the library\'s notes on it). A reel.'), 'Used the library\'s notes on a shared reel');
        assert.equal(read('Read the caption. It says: «Backend in 37 seconds»'), 'Read the caption of a shared reel');
        assert.equal(read('Saw the cover and caption. A cover.', 'share'), 'Saw the cover of a shared post and its caption');
        assert.equal(read('Saw the cover. A cover.', 'share'), 'Saw the cover of a shared post');
        assert.equal(read('A 37-second reel.'), 'Read a shared reel');
    });

    it('a personal document is an answer the turn hands to a person: the flag is set, and what is described is only "a personal document"', () => {
        const plan = planOf(base({ kind: 'image', about_owner: 'personal', seen: 'a personal document' }), en);
        assert.ok(plan.kind === 'answer');
        assert.equal(plan.perceived.personal, true);
        assert.equal(plan.text, '[photo] a personal document');
    });
});

describe('planOf: a story mention is thanked, never answered', () => {
    const mention = (over: Partial<Perception> = {}) => base({ kind: 'story_mention', about_owner: 'other_content', mention_summary: 'my desk setup with Python code', ...over });

    it('by name, in each register\'s own words, when what it showed is fit to say back', () => {
        const english = planOf(mention(), en);
        assert.ok(english.kind === 'ack' && english.perception);
        assert.equal(english.perception.line, 'Thanks for the mention in your story, and for sharing my desk setup with Python code 🙏 If you have a question, I\'m glad to help.');
        assert.equal(english.perception.reason, 'Read their story mention and thanked them for what they shared.');
        assert.equal(english.perception.perceived, true);

        const arabic = planOf(mention({ mention_summary: 'رحلتي إلى الإسكندرية' }), gulf);
        assert.ok(arabic.kind === 'ack' && arabic.perception);
        assert.equal(arabic.perception.line, 'شكراً على الإشارة في قصتك وعلى مشاركة رحلتي إلى الإسكندرية 🙏 ولو عندك أي سؤال يسعدني أساعدك.');
    });

    it('with the usual thanks when the summary is not fit to say back: a number, a link, a handle, too long, or empty', () => {
        for (const mention_summary of ['50% off sale', 'see shop.example.com', '@someone and me', 'one two three four five six seven eight nine ten', '', undefined]) {
            const plan = planOf(mention({ mention_summary }), en);
            assert.ok(plan.kind === 'ack' && plan.perception, String(mention_summary));
            assert.equal(plan.perception.line, undefined, `${mention_summary}: no line of its own, so the kit's usual thanks goes out`);
            assert.equal(plan.perception.perceived, false);
            assert.equal(plan.perception.reason, 'Read their story mention, but what it showed was not fit to say back, so it sent the usual thanks.');
        }
    });

    it('a mention of a personal document is not named, whatever the summary says', () => {
        const plan = planOf(mention({ about_owner: 'personal' }), en);
        assert.ok(plan.kind === 'ack' && plan.perception);
        assert.equal(plan.perception.line, undefined);
    });
});

describe('planOf: what could not be read with confidence', () => {
    it('is asked for again when the person SENT it: a photo, a video, a shared reel or post, a shared story', () => {
        for (const kind of ['image', 'video', 'reel', 'share', 'story_share'] as const) {
            const plan = planOf(base({ kind, status: 'unreadable', reason: 'low_confidence', seen: undefined }), en);
            assert.ok(plan.kind === 'ack' && plan.perception, kind);
            assert.equal(plan.perception.line, en.resend, kind);
            assert.equal(plan.perception.reason, 'Could not read it with confidence, so it asked them to send it again.');
            assert.equal(plan.perception.perceived, false);
        }
    });

    it('is NOT asked for again when there is nothing for them to send: the story they replied to, or their own story that mentions the account', () => {
        for (const kind of ['story_reply', 'story_mention'] as const) {
            const plan = planOf(base({ kind, status: 'unreadable', reason: 'low_confidence', seen: undefined }), en);
            assert.ok(plan.kind === 'ack' && plan.perception, kind);
            assert.equal(plan.perception.line, undefined, kind);
            assert.equal(plan.perception.reason, 'Could not read it with confidence, so it sent the usual line.');
        }
    });
});

describe('planOf: a read that did not come to be is the usual line, with the reason', () => {
    const table: Array<[Partial<Perception>, string]> = [
        [{ status: 'failed', reason: 'too_large' }, 'Could not read it: it was too large to read, so it sent the usual line.'],
        [{ status: 'failed', reason: 'fetch_failed' }, 'Could not read it: it could not be downloaded, so it sent the usual line.'],
        [{ status: 'failed', reason: 'expired_url' }, 'Could not read it: its link had expired, so it sent the usual line.'],
        [{ status: 'failed', reason: 'provider_error' }, 'Could not read it: the reading service could not read it, so it sent the usual line.'],
        [{ status: 'failed', reason: 'timeout' }, 'Could not read it: it took too long, so it sent the usual line.'],
        [{ status: 'failed', reason: 'decode_failed' }, 'Could not read it: the voice note could not be decoded, so it sent the usual line.'],
        [{ status: 'skipped', reason: 'budget' }, 'Could not read it: the daily limit for reading media was reached, so it sent the usual line.'],
        [{ status: 'skipped', reason: 'no_key' }, 'Could not read it: no Meta key is set up for reading media, so it sent the usual line.'],
        [{ status: 'skipped', reason: 'no_url' }, 'Could not read it: there was nothing in it to open, so it sent the usual line.'],
    ];
    for (const [over, sentence] of table) {
        it(`${over.status} / ${over.reason}`, () => {
            const plan = planOf(base({ ...over, seen: undefined }), en);
            assert.ok(plan.kind === 'ack' && plan.perception);
            assert.equal(plan.perception.line, undefined, 'the kit\'s usual line, chosen by the acknowledgement');
            assert.equal(plan.perception.perceived, false);
            assert.equal(plan.perception.reason, sentence);
        });
    }

    it('a reason it does not know still says it was not read, in one sentence', () => {
        assert.equal(notReadReason({ status: 'failed', reason: undefined }), 'Could not read it, so it sent the usual line.');
        assert.equal(notReadReason({ status: 'skipped', reason: 'switch_off' }), 'Could not read it, so it sent the usual line.');
    });
});
