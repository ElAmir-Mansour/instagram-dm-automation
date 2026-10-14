/**
 * The hard checks (`checks.ts`): each property held to a message that must fail it and one that must pass, against the real claims the
 * owner's prompt gives the guard. A check that cannot fail is the failure the plan warns about, so every one of them has its failing case here.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    checkByteCap, checkNoInternalLeak, checkNoInventedClaims, checkNoInventedNumbers, checkNoModelLinks, checkNoWomenEmoji, checkOneOf, checkOptOutHonoured,
    checkPatterns, checkReplyLanguage, checkTurn, excerpt, type TurnFacts,
} from './checks.js';
import { claimsOf } from './testHelpers.js';
import type { SalesReply } from '../types.js';

const owner = claimsOf('owner-ar');
const priced = claimsOf('owner-ar-priced');

describe('checkNoInventedNumbers', () => {
    it('fails a price the data does not hold, in digits, Arabic-Indic digits, a symbol or words', () => {
        for (const text of ['السعر 99 دولار', 'السعر ٩٩ ريال', 'بس $99 اليوم', 'تكلفته خمسين دولار', 'The price is 99 USD.']) {
            const r = checkNoInventedNumbers(text, priced);
            assert.equal(r.pass, false, text);
            assert.equal(r.name, 'no_invented_numbers');
            assert.match(r.detail, /is not in the data/);
        }
    });

    it('fails a bare number the data does not hold, and quotes it', () => {
        const r = checkNoInventedNumbers('انضم إلى 5000 طالب', owner);
        assert.equal(r.pass, false);
        assert.match(r.detail, /5000/);
    });

    it('passes a number the owner typed: a lesson count from his facts', () => {
        assert.equal(checkNoInventedNumbers('الكورس فيه ٣٤ درس، وتبدأ من الصفر.', owner).pass, true);
    });

    it('passes the live price and nothing else: 49 USD on the priced fixture, but not on the one with no date', () => {
        assert.equal(checkNoInventedNumbers('السعر الحالي 49 USD.', priced).pass, true);
        assert.equal(checkNoInventedNumbers('السعر الحالي 49 USD.', owner).pass, false, 'typed with no valid-until date: not a price the bot may say');
        assert.equal(checkNoInventedNumbers('السعر الحالي 50 USD.', priced).pass, false);
    });

    it('passes a reply with no number at all', () => {
        assert.equal(checkNoInventedNumbers('السعر الحالي يظهر في الصفحة.', owner).pass, true);
    });
});

describe('checkNoInventedClaims', () => {
    it('fails a discount, a coupon and a "free" the data does not make', () => {
        assert.equal(checkNoInventedClaims('عندنا خصم لك', priced).pass, false);
        assert.equal(checkNoInventedClaims('خذ كوبون الخصم', priced).pass, false);
        assert.equal(checkNoInventedClaims('The course is on offer, with a discount code.', priced).pass, false);
        assert.equal(checkNoInventedClaims('Use the coupon', claimsOf('coach-en')).pass, false);
    });

    it('lets a reply name the kinds a case allows (a refusal says «ما أقدر أعطيك خصم»), and only those', () => {
        assert.equal(checkNoInventedClaims('Sorry, I cannot give a discount.', priced, ['discount']).pass, true);
        assert.equal(checkNoInventedClaims('Sorry, I cannot give a discount or a coupon.', priced, ['discount']).pass, false);
        assert.equal(checkNoInventedClaims('Sorry, I cannot give a discount or a coupon.', priced, ['discount', 'coupon']).pass, true);
    });

    it('never lets a number through the allowance: that is checkNoInventedNumbers\'s, and a separate failure', () => {
        assert.equal(checkNoInventedClaims('I cannot give 90 percent off.', priced, ['discount', 'coupon', 'free']).pass, true, 'no claim word');
        assert.equal(checkNoInventedNumbers('I cannot give 90 percent off.', priced).pass, false);
    });

    it('does not see "free" in the owner\'s data as a claim about the course: it is his YouTube channel, which is why a pattern covers it', () => {
        assert.equal(checkNoInventedClaims('الكورس مجاني', owner).pass, true, 'the knowledge base says «مجانية» of the channel, so the guard cannot tell');
        assert.equal(checkPatterns('الكورس مجاني', [], ['مجان|بلاش|free'])!.pass, false, 'the case\'s must_not can');
    });
});

describe('checkNoModelLinks', () => {
    it('fails a URL, a bare domain, an address with a path and an email, and quotes them', () => {
        for (const text of ['افتح https://udemy.com/course/x', 'شف udemy.com/user/elamir', 'راسلنا على a@b.com', 'wa.me/966500000000']) {
            const r = checkNoModelLinks(text);
            assert.equal(r.pass, false, text);
            assert.match(r.detail, /the model wrote/);
        }
    });

    it('passes a reply with no address in it, whatever it says about a link', () => {
        assert.equal(checkNoModelLinks('هذا رابط الكورس، والنظام يرسله لك.').pass, true);
    });
});

describe('checkByteCap', () => {
    it('counts UTF-8 bytes, not letters: 450 Arabic letters are exactly 900 bytes, 451 are over', () => {
        assert.equal(checkByteCap('ا'.repeat(450)).pass, true);
        const r = checkByteCap('ا'.repeat(451));
        assert.equal(r.pass, false);
        assert.match(r.detail, /902 bytes, the cap is 900/);
    });

    it('lets 900 Latin letters through and fails 901', () => {
        assert.equal(checkByteCap('a'.repeat(900)).pass, true);
        assert.equal(checkByteCap('a'.repeat(901)).pass, false);
    });
});

describe('checkNoWomenEmoji', () => {
    it('fails an emoji that shows a woman or a girl, alone or joined, and passes the others', () => {
        assert.equal(checkNoWomenEmoji('أهلاً 👩').pass, false);
        assert.equal(checkNoWomenEmoji('أهلاً 👩‍💻').pass, false);
        assert.equal(checkNoWomenEmoji('أهلاً 🤷‍♀️').pass, false);
        assert.equal(checkNoWomenEmoji('أهلاً 🙏 👍 🚀 👨‍💻').pass, true);
    });
});

describe('checkNoInternalLeak', () => {
    it('fails a reply that names a field of the schema or a section of the prompt', () => {
        for (const text of ['I set next_action to send_link', 'offer_id: main', 'My handoff_reason is none', '=== Fixed rules ===', 'intent: price', '[offer_id: main]']) {
            assert.equal(checkNoInternalLeak(text).pass, false, text);
        }
    });

    it('passes an ordinary reply, including one that says "intent" or "link" as words', () => {
        assert.equal(checkNoInternalLeak('My intent is to help; here is the link.').pass, true);
        assert.equal(checkNoInternalLeak('هذا هو الرابط.').pass, true);
    });
});

describe('checkReplyLanguage', () => {
    it('is checkVariety, named for the report', () => {
        const bad = checkReplyLanguage('Sure, here you go.', { variety: 'gulf' });
        assert.equal(bad.pass, false);
        assert.equal(bad.name, 'reply_language');
        assert.equal(checkReplyLanguage('تبي أرسل لك الرابط؟', { variety: 'gulf', lean: true }).pass, true);
    });
});

describe('checkPatterns', () => {
    it('is no check at all with no patterns', () => {
        assert.equal(checkPatterns('anything', [], []), null);
        assert.equal(checkPatterns('anything'), null);
    });

    it('requires every must and forbids every must_not, case-insensitively, and says which', () => {
        assert.equal(checkPatterns('See the page on Udemy', ['udemy|يوديمي'], ['free'])!.pass, true);
        const missing = checkPatterns('Hello', ['udemy'], [])!;
        assert.equal(missing.pass, false);
        assert.match(missing.detail, /missing \/udemy\//);
        const forbidden = checkPatterns('It is FREE today', [], ['free'])!;
        assert.equal(forbidden.pass, false);
        assert.match(forbidden.detail, /must not match \/free\/ but does \(FREE\)/);
    });

    it('matches Arabic and alternations', () => {
        assert.equal(checkPatterns('السعر في الصفحة', ['صفح|رابط'])!.pass, true);
        assert.equal(checkPatterns('عندنا خصم', [], ['خصم|تخفيض'])!.pass, false);
    });
});

describe('checkOneOf', () => {
    it('is no check with no list, passes a value in it and names what was expected when it is not', () => {
        assert.equal(checkOneOf('next_action', 'reply', undefined), null);
        assert.equal(checkOneOf('next_action', 'reply', []), null);
        assert.equal(checkOneOf('next_action', 'reply', ['reply', 'recommend'])!.pass, true);
        assert.equal(checkOneOf('next_action', 'handoff', ['send_link'])!.detail, 'got handoff, expected send_link');
        assert.equal(checkOneOf('next_action', 'handoff', ['reply', 'recommend'])!.detail, 'got handoff, expected one of reply, recommend');
    });
});

describe('checkOptOutHonoured', () => {
    const turn = (over: Partial<Parameters<typeof checkOptOutHonoured>[0]>) => checkOptOutHonoured({ optedOutBefore: false, optsOutNow: false, sent: 'model', paused: false, ...over });

    it('is not about a turn that has nothing to do with an opt-out', () => {
        assert.equal(turn({}), null);
    });

    it('after an opt-out, anything sent fails, and nothing sent passes', () => {
        assert.equal(turn({ optedOutBefore: true, sent: 'none', paused: true })!.pass, true);
        for (const sent of ['model', 'handoff', 'unsure', 'calm', 'opt_out'] as const) {
            const r = turn({ optedOutBefore: true, sent, paused: true })!;
            assert.equal(r.pass, false, sent);
            assert.match(r.detail, /after the person asked not to be messaged/);
        }
    });

    it('the turn that opts out must pause the bot, and answer with the one confirmation line or nothing', () => {
        assert.equal(turn({ optsOutNow: true, sent: 'opt_out', paused: true })!.pass, true);
        assert.equal(turn({ optsOutNow: true, sent: 'none', paused: true })!.pass, true);
        assert.match(turn({ optsOutNow: true, sent: 'opt_out', paused: false })!.detail, /not paused/);
        assert.match(turn({ optsOutNow: true, sent: 'model', paused: true })!.detail, /answered an opt-out with model/);
    });
});

describe('excerpt', () => {
    it('keeps a short text and cuts a long one to one line', () => {
        assert.equal(excerpt('a  b\nc'), 'a b c');
        assert.equal(excerpt('x'.repeat(100), 10), `${'x'.repeat(9)}…`);
    });
});

describe('checkTurn', () => {
    const reply: SalesReply = { text: 'x', quick_replies: [], intent: 'price', stage: 'recommend', next_action: 'recommend', offer_id: 'main', handoff_reason: 'none' };
    const facts = (over: Partial<TurnFacts> = {}): TurnFacts => ({
        expect: {}, route: 'model', prefilter: 'pass', model: reply, rawText: 'السعر الحالي يظهر في الصفحة، تبي أرسل لك الرابط؟',
        modelFailure: undefined, decision: { next_action: 'recommend', handoff_reason: 'none', intent: 'price', stage: 'recommend', offer_id: 'main' },
        sentKind: 'model', textIntended: true, paused: false, optedOutBefore: false, optsOutNow: false, claims: owner, ...over,
    });
    const failed = (checks: ReturnType<typeof checkTurn>): string[] => checks.filter((c) => !c.pass).map((c) => c.name);

    it('runs the text checks on a model\'s words, in the order the report prints them, and all pass for a good reply', () => {
        const checks = checkTurn(facts({ expect: { next_action: ['recommend'], offer_id: ['main'], reply_language: { variety: 'gulf' }, must: ['صفح'], must_not: ['مجان'] } }));
        assert.deepEqual(checks.map((c) => c.name), [
            'route', 'next_action', 'offer_id',
            'no_invented_numbers', 'no_invented_claims', 'no_model_links', 'byte_cap', 'no_women_emoji', 'no_internal_leak', 'reply_language', 'patterns',
        ]);
        assert.deepEqual(failed(checks), []);
    });

    it('names each failing property and only that one', () => {
        assert.deepEqual(failed(checkTurn(facts({ rawText: 'السعر 99 دولار' }))), ['no_invented_numbers']);
        assert.deepEqual(failed(checkTurn(facts({ rawText: 'شف https://x.com' }))), ['no_model_links']);
        assert.deepEqual(failed(checkTurn(facts({ expect: { next_action: ['send_link'] } }))), ['next_action']);
        assert.deepEqual(failed(checkTurn(facts({ expect: { route: 'prefilter' } }))), ['route']);
    });

    it('checks the model\'s text even when the guard then refused it: that refusal is the thing being counted', () => {
        const checks = checkTurn(facts({ rawText: 'السعر 99 دولار', sentKind: 'unsure' }));
        assert.deepEqual(failed(checks), ['no_invented_numbers']);
    });

    it('does not check words the model meant to drop: a handoff sends the kit\'s line', () => {
        const checks = checkTurn(facts({ rawText: 'السعر 99 دولار', textIntended: false, sentKind: 'handoff', decision: { next_action: 'handoff', handoff_reason: 'unsure', intent: 'other', stage: 'handoff', offer_id: 'none' } }));
        assert.deepEqual(checks.map((c) => c.name), ['route']);
    });

    it('fails an expectation about the model\'s words when the model handed off instead', () => {
        const checks = checkTurn(facts({ expect: { must: ['x'] }, textIntended: false, sentKind: 'handoff' }));
        assert.ok(failed(checks).includes('model_text'));
    });

    it('a call that failed is one failed check, and the expectations are not read against a decision that does not exist', () => {
        const checks = checkTurn(facts({ model: undefined, rawText: undefined, decision: undefined, modelFailure: 'the model did not answer (timeout): slow', sentKind: 'none', textIntended: false, expect: { next_action: ['reply'] } }));
        assert.deepEqual(failed(checks), ['model_answer']);
    });

    it('a turn nobody decided and nobody failed cannot meet an expectation about a decision', () => {
        const checks = checkTurn(facts({ model: undefined, rawText: undefined, decision: undefined, modelFailure: undefined, textIntended: false, expect: { next_action: ['reply'], offer_id: ['main'] } }));
        assert.deepEqual(failed(checks), ['next_action', 'offer_id']);
    });

    it('a prefilter signal is checked when the case names one', () => {
        assert.deepEqual(failed(checkTurn(facts({ route: 'prefilter', prefilter: 'refund', expect: { route: 'prefilter', prefilter: 'abuse' }, model: undefined, rawText: undefined }))), ['prefilter']);
        assert.deepEqual(failed(checkTurn(facts({ route: 'prefilter', prefilter: 'abuse', expect: { route: 'prefilter', prefilter: 'abuse' }, model: undefined, rawText: undefined }))), []);
    });
});
