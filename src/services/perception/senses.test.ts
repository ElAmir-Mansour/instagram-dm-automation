/**
 * What the agent can take in (`senses.ts`): which words ask about it, which line each answer is, and that the gate is asked once per sense and never without a cue.
 * Pure but for the gate, which every test hands in: nothing reaches a database, a setting or a model.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { salesFactsBlock } from '../dmSales/prompt.js';
import type { SalesFacts } from '../dmSales/types.js';
import { contextFor } from '../profile/context.js';
import { FITNESS_EN } from '../profile/fixtures.js';
import type { GateArgs, GateResult } from './gate.js';
import { hasSensesCue, SENSES_FACTS, sensesCues, sensesFact, sensesForTurn } from './senses.js';

let logged: { level: string; event: string; [k: string]: unknown }[] = [];
let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

describe('sensesCues: the words that ask whether a voice note or a photo would be taken in', () => {
    it('hears a voice word, in Arabic as people type it and in English', () => {
        for (const text of ['ممكن اسجل صوت اشرح؟', 'أبعتلك رسالة صوتية؟', 'بعتلك فويس', 'ينفع ڤويس؟', 'اقدر ابعت ريكورد؟', 'أرسل أوديو؟', 'بالصوت أسهل', 'Can I send you a voice note?', 'is a VOICE message ok', 'can I record it', 'sent you an audio', 'Voicenotes fine?']) {
            assert.deepEqual(sensesCues(text), ['voice'], text);
        }
    });

    it('sees a picture word, in Arabic as people type it and in English', () => {
        for (const text of ['ممكن ابعتلك صورة؟', 'شوف صورتي', 'بعتلك الصور', 'معايا سكرين شوت', 'هبعت اسكرين', 'لقطة شاشة من الخطأ', 'صـــورة', 'can I send a photo?', 'here is a screenshot', 'a screen shot of the error', 'pics ok?', 'I have an image of it', 'Pictures?']) {
            assert.deepEqual(sensesCues(text), ['dm_media'], text);
        }
    });

    it('names both when a message asks about both, voice first', () => {
        assert.deepEqual(sensesCues('ابعت صورة ولا فويس؟'), ['voice', 'dm_media']);
        assert.deepEqual(sensesCues('a photo or a voice note, which is easier?'), ['voice', 'dm_media']);
    });

    it('is not fooled by a word that only contains the letters: photography, voting, imagine, lectures that were recorded', () => {
        for (const text of ['عندكم دورة تصوير؟', 'التصويت امتى؟', 'imagine that', 'are the lectures recorded?', 'a pictorial', 'photography classes?']) {
            assert.deepEqual(sensesCues(text), [], text);
        }
    });

    it('leaves video and reel words to recall: they ask FOR a video far more often than to send one', () => {
        for (const text of ['عندك فيديو عن الباك اند؟', 'ابعتلك ريل؟', 'Do you have a video about docker?', 'can I send a reel?']) {
            assert.deepEqual(sensesCues(text), [], text);
        }
    });

    it('is empty for nothing, blanks, and anything that is not text', () => {
        for (const value of ['', '   ', null, undefined, 7, { text: 'voice' }, ['photo']]) assert.deepEqual(sensesCues(value), []);
        assert.equal(hasSensesCue('voice?'), true);
        assert.equal(hasSensesCue('How much is the plan?'), false);
    });
});

describe('sensesFact: one line for what the gate let through', () => {
    it('says what is taken in, to say yes when asked, and that an older line of the chat is out of date', () => {
        assert.equal(sensesFact(['voice']), SENSES_FACTS.voice);
        assert.equal(sensesFact(['dm_media']), SENSES_FACTS.dm_media);
        assert.equal(sensesFact(['voice', 'dm_media']), SENSES_FACTS.both);
        assert.equal(sensesFact(['dm_media', 'voice']), SENSES_FACTS.both);
        assert.equal(sensesFact([]), null);
        for (const line of Object.values(SENSES_FACTS)) {
            assert.match(line, /say yes/);
            assert.match(line, /out of date\.$/);
            assert.doesNotMatch(line, /\n|https?:|\d/, 'one line, no link, no number: nothing the guard would have to allow');
        }
    });

    it('is said last in the facts block, and a block without it is byte for byte what it was', () => {
        const ctx = contextFor(FITNESS_EN, 'dm', null);
        const facts: SalesFacts = { stage: 'new', qualifierTurns: 0, linkSentFor: [], video: 'No video on this topic yet.' };
        const without = salesFactsBlock(ctx, facts);
        const withLine = salesFactsBlock(ctx, { ...facts, senses: SENSES_FACTS.voice });
        assert.equal(withLine, `${without}\n${SENSES_FACTS.voice}`);
        assert.equal(salesFactsBlock(ctx, { ...facts, senses: '   ' }), without, 'a blank line is no line');
    });
});

describe('sensesForTurn: cue, then the gate once per sense, then the line', () => {
    const INPUT = { creatorId: 'tenant-1', senderId: 'sender-1' };
    const gateThat = (answer: (args: GateArgs) => GateResult) => {
        const asked: GateArgs[] = [];
        return { asked, gate: async (args: GateArgs) => { asked.push(args); return answer(args); } };
    };

    it('asks the gate for voice with the kind of a voice note, and says the voice line when it passes', async () => {
        const g = gateThat(() => ({ ok: true }));
        logged = [];
        assert.equal(await sensesForTurn({ ...INPUT, text: 'Can I send a voice note?' }, { gate: g.gate }), SENSES_FACTS.voice);
        assert.deepEqual(g.asked, [{ creatorId: 'tenant-1', senderId: 'sender-1', capability: 'voice', kind: 'audio' }]);
        assert.deepEqual(logged.filter((l) => l.event === 'senses.told').map((l) => l['senses']), ['voice']);
    });

    it('asks for photos with the kind of a photo, and for both when both are named', async () => {
        const g = gateThat(() => ({ ok: true }));
        assert.equal(await sensesForTurn({ ...INPUT, text: 'صورة ولا فويس؟' }, { gate: g.gate }), SENSES_FACTS.both);
        assert.deepEqual(g.asked.map((a) => [a.capability, a.kind]), [['voice', 'audio'], ['dm_media', 'image']]);
    });

    it('says only what the gate let through: voice refused and photos open is the photo line', async () => {
        const g = gateThat((args) => (args.capability === 'voice' ? { ok: false, reason: 'switch_off' } : { ok: true }));
        assert.equal(await sensesForTurn({ ...INPUT, text: 'a photo or a voice note?' }, { gate: g.gate }), SENSES_FACTS.dm_media);
    });

    it('is null when the gate refuses every sense: the switch, the sender, the key or the cap', async () => {
        for (const reason of ['switch_off', 'not_allowed_sender', 'no_key', 'budget'] as const) {
            const g = gateThat(() => ({ ok: false, reason }));
            assert.equal(await sensesForTurn({ ...INPUT, text: 'voice note ok?' }, { gate: g.gate }), null, reason);
        }
    });

    it('never asks the gate without a cue', async () => {
        const g = gateThat(() => ({ ok: true }));
        assert.equal(await sensesForTurn({ ...INPUT, text: 'How much is the plan?' }, { gate: g.gate }), null);
        assert.equal(g.asked.length, 0);
    });

    it('never throws: a gate that broke is a turn without the line, logged', async () => {
        logged = [];
        const line = await sensesForTurn({ ...INPUT, text: 'voice?' }, { gate: async () => { throw new Error('settings read failed'); } });
        assert.equal(line, null);
        assert.ok(logged.some((l) => l.event === 'senses.failed' && l.level === 'warn'));
    });
});
