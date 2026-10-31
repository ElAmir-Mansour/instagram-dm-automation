/**
 * The one line of why under a reply the agent gave to something it saw (`trace.ts`): built from closed lists, so it can only say what happened.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HANDOFF_REASONS, INTENTS, NEXT_ACTIONS } from '../dmSales/types.js';
import { REASON_MAX_CHARS, traceReason, type TraceInput } from './trace.js';
import { PERCEIVABLE_KINDS } from './types.js';

const input = (over: Partial<TraceInput> = {}): TraceInput => ({ kind: 'reel', effect: 'reply', action: 'reply', handoffReason: 'none', intent: 'info', ...over });

describe('traceReason', () => {
    it('says what was read, what the code did and why, in one sentence', () => {
        assert.equal(traceReason(input()), 'Read a shared reel; answered from the account\'s own information, because they want to know more.');
        assert.equal(traceReason(input({ kind: 'image', action: 'send_link', intent: 'price' })), 'Read a photo; sent the offer\'s link, because they asked about the price.');
        assert.equal(traceReason(input({ kind: 'story_reply', action: 'ask_qualifier', intent: 'level_fit' })), 'Read a reply to the account\'s story; asked one question to place them, because they asked whether it suits them.');
        assert.equal(traceReason(input({ kind: 'share', action: 'recommend', intent: 'ready_to_buy' })), 'Read a shared post; recommended the offer that fits, because they are ready to buy.');
    });

    it('says a voice note was HEARD, not read, with or without the pipeline saying so: the same words either way', () => {
        assert.equal(traceReason(input({ kind: 'audio', action: 'send_link', intent: 'price' })), 'Heard a voice note; sent the offer\'s link, because they asked about the price.');
        assert.equal(traceReason(input({ kind: 'audio', read: 'Heard a voice note', action: 'send_link', intent: 'price' })), 'Heard a voice note; sent the offer\'s link, because they asked about the price.');
        assert.equal(traceReason(input({ kind: 'audio', modelFailed: true })), 'Heard a voice note, but the model could not answer: a person was told.');
        assert.equal(traceReason(input({ kind: 'audio', effect: 'handoff', action: 'handoff', handoffReason: 'refund' })), 'Heard a voice note; handed the chat to a person, because they raised a refund.');
    });

    it('begins with how it was looked at when the pipeline says so, and every other part of the line is the same', () => {
        assert.equal(traceReason(input({ read: 'Watched a shared reel' })), 'Watched a shared reel; answered from the account\'s own information, because they want to know more.');
        assert.equal(traceReason(input({ read: 'Read the caption of a shared reel', action: 'send_link', intent: 'price' })), 'Read the caption of a shared reel; sent the offer\'s link, because they asked about the price.');
        assert.equal(traceReason(input({ read: 'Watched a shared reel', modelFailed: true })), 'Watched a shared reel, but the model could not answer: a person was told.');
        assert.equal(traceReason(input({ read: 'Watched a shared reel', effect: 'handoff', action: 'handoff', handoffReason: 'wants_human' })), 'Watched a shared reel; handed the chat to a person, because they asked for a person.');
        // A personal document says only what it is, whatever else it was given: nothing of how it was looked at.
        assert.equal(traceReason(input({ kind: 'image', read: 'Saw the cover of a shared post', personal: true })), 'Read a photo: it is a personal document, so the chat went to a person without describing it.');
    });

    it('leaves the "because" out when the intent says nothing, and for no intent at all', () => {
        assert.equal(traceReason(input({ intent: 'other' })), 'Read a shared reel; answered from the account\'s own information.');
        assert.equal(traceReason(input({ intent: null })), 'Read a shared reel; answered from the account\'s own information.');
    });

    it('a hand-off the model asked for names why, in the code\'s words', () => {
        assert.equal(traceReason(input({ effect: 'handoff', action: 'handoff', handoffReason: 'unsure' })), 'Read a shared reel; handed the chat to a person, because the information it has does not answer this.');
        assert.equal(traceReason(input({ effect: 'handoff', action: 'handoff', handoffReason: 'wants_human' })), 'Read a shared reel; handed the chat to a person, because they asked for a person.');
        assert.equal(traceReason(input({ effect: 'handoff', action: 'handoff', handoffReason: 'none' })), 'Read a shared reel; handed the chat to a person.');
    });

    it('a personal document and a model that could not answer are said plainly, and say nothing of the media', () => {
        assert.equal(traceReason(input({ kind: 'image', personal: true })), 'Read a photo: it is a personal document, so the chat went to a person without describing it.');
        assert.equal(traceReason(input({ modelFailed: true })), 'Read a shared reel, but the model could not answer: a person was told.');
    });

    it('an insult and a loop are said too', () => {
        assert.equal(traceReason(input({ effect: 'calm' })), 'Read a shared reel; sent one calm line.');
        assert.equal(traceReason(input({ effect: 'pause' })), 'Read a shared reel; stopped replying.');
    });

    it('is one line within the limit for every kind, action, intent and hand-off reason, with no digit and no quote in it', () => {
        for (const kind of PERCEIVABLE_KINDS) {
            for (const action of NEXT_ACTIONS) {
                for (const intent of [...INTENTS, null]) {
                    for (const handoffReason of HANDOFF_REASONS) {
                        for (const effect of ['reply', 'handoff', 'close', 'calm', 'pause'] as const) {
                            const line = traceReason({ kind, effect, action, intent, handoffReason });
                            assert.ok(line.length <= REASON_MAX_CHARS, line);
                            assert.ok(!/\n/.test(line), line);
                            assert.ok(/^(Read|Heard) /.test(line) && /\.$/.test(line), line);
                            assert.ok(!/\d|["«»]/.test(line), line);
                        }
                    }
                }
            }
        }
    });

    it('stays far inside its limit: the longest line there can be is well under it', () => {
        let longest = 0;
        for (const kind of PERCEIVABLE_KINDS) for (const hr of HANDOFF_REASONS) longest = Math.max(longest, traceReason({ kind, effect: 'handoff', action: 'handoff', handoffReason: hr, intent: null }).length);
        assert.ok(longest < REASON_MAX_CHARS, `${longest}`);
        assert.equal(REASON_MAX_CHARS, 200);
    });
});

describe('traceReason when the owner\'s video library was looked into (recall)', () => {
    const recalled = (over: Partial<TraceInput> = {}): TraceInput => ({ effect: 'reply', action: 'reply', handoffReason: 'none', intent: 'info', ...over });

    it('says a video was found and the second it points to, beginning the line when nothing was read', () => {
        assert.equal(traceReason(recalled({ recall: { found: true, second: 13 } })), 'Found a video in the library (from 0:13); answered from the account\'s own information, because they want to know more.');
        assert.equal(traceReason(recalled({ recall: { found: true, second: 65 }, action: 'send_link', intent: 'price' })), 'Found a video in the library (from 1:05); sent the offer\'s link, because they asked about the price.');
    });

    it('leaves the second out when the video starts the answer', () => {
        assert.equal(traceReason(recalled({ recall: { found: true, second: 0 } })), 'Found a video in the library; answered from the account\'s own information, because they want to know more.');
    });

    it('says plainly when the library had nothing on it', () => {
        assert.equal(traceReason(recalled({ recall: { found: false } })), 'Looked in the video library and found nothing on it; answered from the account\'s own information, because they want to know more.');
    });

    it('says what was read first and what the library gave second, as they happened', () => {
        assert.equal(traceReason({ ...recalled({ recall: { found: true, second: 13 } }), kind: 'story_reply' }), 'Read a reply to the account\'s story, and found a video in the library (from 0:13); answered from the account\'s own information, because they want to know more.');
        assert.equal(traceReason({ ...recalled({ recall: { found: false } }), kind: 'share', read: 'Saw the cover of a shared post' }), 'Saw the cover of a shared post, and looked in the video library and found nothing on it; answered from the account\'s own information, because they want to know more.');
    });

    it('is the same line for the other endings: a hand-off, a calm word, a stop, and a model that could not answer', () => {
        const r = { recall: { found: true, second: 7 } } as const;
        assert.equal(traceReason(recalled({ ...r, effect: 'handoff', action: 'handoff', handoffReason: 'wants_human' })), 'Found a video in the library (from 0:07); handed the chat to a person, because they asked for a person.');
        assert.equal(traceReason(recalled({ ...r, effect: 'calm' })), 'Found a video in the library (from 0:07); sent one calm line.');
        assert.equal(traceReason(recalled({ ...r, effect: 'pause' })), 'Found a video in the library (from 0:07); stopped replying.');
        assert.equal(traceReason(recalled({ ...r, modelFailed: true })), 'Found a video in the library (from 0:07), but the model could not answer: a person was told.');
    });

    it('is one line within the limit for every kind (or none), action, intent and hand-off reason, and its only digits are the second it points to', () => {
        for (const kind of [undefined, ...PERCEIVABLE_KINDS]) {
            for (const recall of [{ found: true, second: 3725 }, { found: false }] as const) {
                for (const action of NEXT_ACTIONS) {
                    for (const intent of [...INTENTS, null]) {
                        for (const handoffReason of HANDOFF_REASONS) {
                            for (const effect of ['reply', 'handoff', 'close', 'calm', 'pause'] as const) {
                                const line = traceReason({ ...(kind ? { kind } : {}), recall, effect, action, intent, handoffReason });
                                assert.ok(line.length <= REASON_MAX_CHARS, line);
                                assert.ok(!/\n/.test(line) && /\.$/.test(line), line);
                                assert.ok(!/["«»]/.test(line), line);
                                assert.equal(/\d/.test(line.replace(/\(from \d+:\d\d\)/, '')), false, line);
                            }
                        }
                    }
                }
            }
        }
    });
});
