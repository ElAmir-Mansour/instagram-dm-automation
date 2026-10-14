/**
 * Making the model's answer true (`coerce.ts`). Never throws; every way the answer can be wrong has one smaller claim to fall back to;
 * the answer agrees with itself afterwards; an offer with no link is never recommended; and the text fits Instagram's 1,000 BYTES.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { coerceSalesReply, type CoerceOptions } from './coerce.js';
import { utf8Bytes } from './text.js';
import { MAX_REPLY_BYTES, type SalesReply } from './types.js';

const OFFERS: CoerceOptions['offers'] = [{ id: 'main', hasLink: true }, { id: 'call', hasLink: false }];
const OPTS: CoerceOptions = { offers: OFFERS };

/** An answer that is already true: each test changes the one thing it is about. */
const GOOD = { intent: 'info', stage: 'qualify', next_action: 'reply', offer_id: 'none', handoff_reason: 'none', text: 'هلا! وش المستوى اللي تبيه؟', quick_replies: [] };
const coerce = (over: Record<string, unknown> = {}, options: CoerceOptions = OPTS) => coerceSalesReply({ ...GOOD, ...over }, options);

describe('coerceSalesReply: an answer that is already true comes back as it was', () => {
    it('with nothing repaired', () => {
        const out = coerce();
        assert.deepEqual(out.repaired, []);
        assert.equal(out.usable, true);
        assert.deepEqual(out.reply, GOOD);
    });

    it('for every combination of the model\'s own words that agrees with itself', () => {
        for (const [action, offer, reason] of [
            ['reply', 'none', 'none'], ['ask_qualifier', 'none', 'none'], ['recommend', 'main', 'none'], ['send_link', 'main', 'none'],
            ['handoff', 'none', 'unsure'], ['handoff', 'main', 'refund'], ['close', 'none', 'none'],
        ] as const) {
            const out = coerce({ next_action: action, offer_id: offer, handoff_reason: reason });
            assert.deepEqual(out.repaired, [], `${action}/${offer}/${reason}`);
            assert.equal(out.reply.next_action, action);
            assert.equal(out.reply.offer_id, offer);
        }
    });
});

describe('coerceSalesReply: a field that is not what the schema said', () => {
    it('reads anything that is not an object as an empty answer, and says so', () => {
        for (const bad of [null, undefined, 'hello', 42, [], [GOOD]]) {
            const out = coerceSalesReply(bad, OPTS);
            assert.equal(out.reply.text, '');
            assert.equal(out.reply.next_action, 'reply');
            assert.equal(out.usable, false, 'nothing to send');
            if (bad !== undefined && bad !== null) assert.ok(out.repaired.includes('answer'));
        }
    });

    it('reads a value outside an enum as the safe one: intent "other", stage the conversation\'s own, action "reply", reason "none"', () => {
        const out = coerce({ intent: 'chitchat', stage: 'closing', next_action: 'upsell', handoff_reason: 'because' }, { ...OPTS, fallbackStage: 'recommend' });
        assert.equal(out.reply.intent, 'other');
        assert.equal(out.reply.stage, 'recommend');
        assert.equal(out.reply.next_action, 'reply');
        assert.equal(out.reply.handoff_reason, 'none');
        assert.deepEqual(out.repaired.sort(), ['handoff_reason', 'intent', 'next_action', 'stage']);
    });

    it('reads a stage the model did not give as "new" when the conversation has none either', () => {
        assert.equal(coerceSalesReply({ ...GOOD, stage: undefined }, OPTS).reply.stage, 'new');
    });

    it('reads a wrong type as the safe value: a number as text, an object as nothing', () => {
        assert.equal(coerce({ text: 349 }).reply.text, '349');
        assert.equal(coerce({ text: true }).reply.text, 'true');
        assert.equal(coerce({ text: { say: 'hi' } }).reply.text, '', 'not "[object Object]"');
        assert.equal(coerce({ text: ['a'] }).reply.text, '');
        assert.ok(coerce({ text: { say: 'hi' } }).repaired.includes('text'));
        assert.equal(coerce({ intent: 5, stage: null }).reply.intent, 'other');
    });

    it('strips control characters and trailing line spaces from the text, and trims it', () => {
        assert.equal(coerce({ text: '  هلا\u0000\u0007 بك  \n\t' }).reply.text, 'هلا بك');
        assert.equal(coerce({ text: 'a  \nb' }).reply.text, 'a\nb');
    });
});

describe('coerceSalesReply: an offer', () => {
    it('is "none" when the prompt did not list it, and a recommendation of it is then only a reply: there is nothing to link to', () => {
        const out = coerce({ next_action: 'send_link', offer_id: 'invented' });
        assert.equal(out.reply.offer_id, 'none');
        assert.equal(out.reply.next_action, 'reply');
        assert.deepEqual(out.repaired.sort(), ['next_action', 'offer_id']);
    });

    it('recommending or linking with no offer named is only a reply: the server will not guess which one was meant', () => {
        for (const action of ['recommend', 'send_link']) {
            const out = coerce({ next_action: action, offer_id: 'none' });
            assert.equal(out.reply.next_action, 'reply', action);
            assert.ok(out.repaired.includes('next_action'));
        }
    });

    it('with no link is never recommended and never linked: a person answers, and the model\'s text is not what is sent', () => {
        for (const action of ['recommend', 'send_link']) {
            const out = coerce({ next_action: action, offer_id: 'call' });
            assert.equal(out.reply.next_action, 'handoff', action);
            assert.equal(out.reply.handoff_reason, 'unsure');
            assert.equal(out.reply.offer_id, 'none');
            assert.equal(out.usable, true, 'a handoff has its own message');
        }
    });

    it('with no link may still be asked about: a plain reply that names it stays one', () => {
        const out = coerce({ next_action: 'reply', offer_id: 'call' });
        assert.equal(out.reply.next_action, 'reply');
        assert.equal(out.reply.offer_id, 'call');
    });
});

describe('coerceSalesReply: the answer has to agree with itself', () => {
    it('a handoff reason means a handoff, whatever the action said', () => {
        for (const reason of ['unsure', 'refund', 'complaint', 'wants_human', 'hot_lead', 'abuse']) {
            const out = coerce({ next_action: 'reply', handoff_reason: reason });
            assert.equal(out.reply.next_action, 'handoff', reason);
            assert.equal(out.reply.handoff_reason, reason);
        }
    });

    it('a handoff with no reason is "unsure"', () => {
        const out = coerce({ next_action: 'handoff', handoff_reason: 'none' });
        assert.equal(out.reply.handoff_reason, 'unsure');
        assert.ok(out.repaired.includes('handoff_reason'));
    });

    it('a refund or a complaint is handed off, with the reason it names, or "complaint"', () => {
        const bare = coerce({ intent: 'refund_or_complaint' });
        assert.equal(bare.reply.next_action, 'handoff');
        assert.equal(bare.reply.handoff_reason, 'complaint');
        const named = coerce({ intent: 'refund_or_complaint', handoff_reason: 'refund' });
        assert.equal(named.reply.handoff_reason, 'refund');
    });

    it('a request for a person is handed off', () => {
        const out = coerce({ intent: 'wants_human' });
        assert.equal(out.reply.next_action, 'handoff');
        assert.equal(out.reply.handoff_reason, 'wants_human');
    });

    it('a person who opted out is closed, not sold to', () => {
        assert.equal(coerce({ intent: 'opt_out', next_action: 'recommend', offer_id: 'main' }).reply.next_action, 'close');
        assert.equal(coerce({ intent: 'opt_out', next_action: 'close' }).reply.next_action, 'close');
        assert.equal(coerce({ intent: 'opt_out', next_action: 'handoff', handoff_reason: 'complaint' }).reply.next_action, 'handoff', 'a handoff is not turned into a close');
    });

    it('an insult is not forced anywhere: whether the second one pauses the bot is the flow\'s to say', () => {
        const out = coerce({ intent: 'abuse' });
        assert.equal(out.reply.next_action, 'reply');
        assert.equal(out.reply.handoff_reason, 'none');
    });
});

describe('coerceSalesReply: the quick replies', () => {
    it('keeps at most three, each with a title of at most 20 characters and a code for a payload', () => {
        const out = coerce({
            quick_replies: [
                { title: 'مبتدئ', payload: 'LEVEL_BEGINNER' }, { title: 'متوسط', payload: 'LEVEL_MID' }, { title: 'متقدم', payload: 'LEVEL_ADV' }, { title: 'رابع', payload: 'FOURTH' },
            ],
        });
        assert.equal(out.reply.quick_replies.length, 3);
        assert.deepEqual(out.reply.quick_replies[0], { title: 'مبتدئ', payload: 'LEVEL_BEGINNER' });
        assert.ok(out.repaired.includes('quick_replies'), 'the fourth was dropped, and that is noted');
    });

    it('cuts a title at 20 characters by what a person sees, never inside an emoji or a letter with its marks', () => {
        const out = coerce({ quick_replies: [{ title: 'ا'.repeat(19) + '👨‍👩‍👧 وأكثر', payload: 'X' }] });
        const title = out.reply.quick_replies[0]!.title;
        assert.equal([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(title)].length, 20);
        assert.ok(title.endsWith('👨‍👩‍👧'));
        const marked = coerce({ quick_replies: [{ title: 'مَرْحَبًا'.repeat(10), payload: 'X' }] }).reply.quick_replies[0]!.title;
        assert.ok([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(marked)].length <= 20);
        assert.ok(!/^[ً-ٟ]/.test(marked.slice(-1)), 'does not end on a stray mark');
    });

    it('drops an entry that is no object or has no title, an empty title, and a title it already has', () => {
        const out = coerce({ quick_replies: [null, 'x', { payload: 'A' }, { title: '  ', payload: 'B' }, { title: 'نعم', payload: 'YES' }, { title: 'نعم', payload: 'YES2' }, { title: 5, payload: 'N' }] });
        assert.deepEqual(out.reply.quick_replies, [{ title: 'نعم', payload: 'YES' }]);
    });

    it('turns a payload into a code (letters, digits, "_", "-", at most 64), or a numbered default when nothing is left', () => {
        const out = coerce({ quick_replies: [{ title: 'a', payload: 'ASK LEVEL!' }, { title: 'b', payload: 'مرحبا' }, { title: 'c', payload: 7 }, { title: 'd', payload: 'X'.repeat(200) }] });
        assert.deepEqual(out.reply.quick_replies.map((q) => q.payload), ['ASKLEVEL', 'QR_2', 'QR_3']);
        assert.equal(coerce({ quick_replies: [{ title: 'd', payload: 'X'.repeat(200) }] }).reply.quick_replies[0]!.payload.length, 64);
    });

    it('reads a list that is no list as no buttons', () => {
        for (const bad of ['yes', 5, { title: 'x' }]) {
            const out = coerce({ quick_replies: bad });
            assert.deepEqual(out.reply.quick_replies, []);
            assert.ok(out.repaired.includes('quick_replies'));
        }
    });
});

describe('coerceSalesReply: Instagram counts bytes, so the text is capped at 900, and a character is never split', () => {
    const bytes = (r: SalesReply): number => utf8Bytes(r.text);

    it('cuts 600 Arabic letters (about 1,200 bytes, which Instagram would refuse) to at most 900 bytes', () => {
        const out = coerce({ text: 'ك'.repeat(600) });
        assert.ok(bytes(out.reply) <= MAX_REPLY_BYTES, `${bytes(out.reply)} bytes`);
        assert.ok(bytes(out.reply) > 800, 'and keeps what fits');
        assert.equal(Buffer.from(out.reply.text).toString('utf8'), out.reply.text);
    });

    it('does not touch a text that fits, 900 bytes exactly included', () => {
        const exact = 'ا'.repeat(450);
        assert.equal(bytes(coerce({ text: exact }).reply), 900);
        assert.equal(coerce({ text: exact }).reply.text, exact);
        assert.deepEqual(coerce({ text: exact }).repaired, []);
    });

    it('takes the link the server adds out of the room: with 120 bytes reserved the text is at most 780', () => {
        const out = coerce({ text: 'ك'.repeat(600) }, { ...OPTS, reserveBytes: 120 });
        assert.ok(bytes(out.reply) <= 780, `${bytes(out.reply)} bytes`);
    });

    it('never leaves less than a hundred bytes of room, however much is reserved', () => {
        const out = coerce({ text: 'ك'.repeat(600) }, { ...OPTS, reserveBytes: 5000 });
        assert.ok(bytes(out.reply) <= 100 && bytes(out.reply) > 0);
    });

    it('does not split a joined emoji at the cap', () => {
        const out = coerce({ text: `${'ا'.repeat(446)}👨‍👩‍👧 تتمة` });
        assert.ok(bytes(out.reply) <= MAX_REPLY_BYTES);
        assert.ok(!out.reply.text.includes('‍'), 'no joiner left dangling');
    });
});

describe('coerceSalesReply: usable', () => {
    it('is false for an answer with no words and no reason to be silent', () => {
        assert.equal(coerce({ text: '' }).usable, false);
        assert.equal(coerce({ text: '   \n' }).usable, false);
    });

    it('is true for a handoff with no words: the kit sends the line', () => {
        assert.equal(coerce({ text: '', next_action: 'handoff', handoff_reason: 'refund' }).usable, true);
    });
});
