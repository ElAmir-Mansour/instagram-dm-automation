/**
 * What is decided before the model reads a message (`prefilter.ts`): refunds and complaints go to a person, a request to stop is an
 * opt-out, an insult is abuse, and everything else passes. The tables are in the dialects the owner's followers write in: فصحى, Gulf and
 * Egyptian, plus English; and the second half is the one that matters as much, the sentences that hold a keyword and must not trigger.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { prefilter, words, type PrefilterDecision } from './prefilter.js';

const kind = (d: PrefilterDecision): string => (d.action === 'handoff' ? `handoff:${d.reason}` : d.action);

describe('prefilter: a refund goes to a person', () => {
    const refunds: [string, string][] = [
        ['فصحى', 'أريد استرجاع المبلغ'],
        ['فصحى', 'أطلب استرداد أموالي'],
        ['فصحى', 'أرجو إعادة المبلغ إلى حسابي'],
        ['Gulf', 'ابي فلوسي'],
        ['Gulf', 'ابغى استرجع فلوسي'],
        ['Gulf', 'رجعوا لي فلوسي لو سمحتوا'],
        ['Gulf', 'ابي ارجاع المبلغ'],
        ['Egyptian', 'عايز فلوسي'],
        ['Egyptian', 'رجعولي الفلوس'],
        ['Egyptian', 'عايز ارجع الفلوس'],
        ['Egyptian', 'ردوا الفلوس يا جماعة'],
        ['Egyptian', 'عايز استرجاع'],
        ['stretched letters', 'فلوووووسي'],
        ['tatweel', 'اسـتـرجـاع'],
        ['diacritics', 'أُريدُ اسْتِرْدَاد'],
        ['English', 'I want a refund'],
        ['English', 'REFUND NOW'],
        ['English', 'give me my money back'],
        ['English', 'I will open a chargeback with my bank'],
        ['English', 'where is my money'],
    ];
    for (const [dialect, text] of refunds) {
        it(`${dialect}: ${text}`, () => {
            const d = prefilter(text);
            assert.equal(kind(d), 'handoff:refund', JSON.stringify(d));
        });
    }

    it('carries what matched, and nothing of the rest of the message', () => {
        const d = prefilter('أهلاً، ابغى استرجع فلوسي ضروري');
        assert.equal(d.action, 'handoff');
        if (d.action !== 'handoff') return;
        assert.equal(d.matched, 'استرجع');
        assert.deepEqual(d.also, []);
    });
});

describe('prefilter: a complaint goes to a person', () => {
    const complaints: [string, string][] = [
        ['فصحى', 'سأقدم شكوى رسمية ضدكم'],
        ['فصحى', 'هذا احتيال واضح'],
        ['فصحى', 'سأبلغ عنكم الجهات المختصة'],
        ['فصحى', 'سأتواصل مع محامي'],
        ['Gulf', 'انتم نصابين'],
        ['Gulf', 'هذا نصب'],
        ['Gulf', 'راح اشتكي عليكم'],
        ['Gulf', 'حرامية'],
        ['Egyptian', 'انتو نصابين والله'],
        ['Egyptian', 'هرفع قضية عليكم'],
        ['Egyptian', 'ضحكتوا عليا'],
        ['Egyptian', 'هبلغ عنكم'],
        ['with a prefix', 'والنصب هذا مو حلال'],
        ['English', 'this is a scam'],
        ['English', 'I will report you'],
        ['English', 'I am calling my lawyer'],
        ['English', 'fraud!'],
        ['English', 'I want to make a complaint'],
    ];
    for (const [dialect, text] of complaints) {
        it(`${dialect}: ${text}`, () => {
            const d = prefilter(text);
            assert.equal(kind(d), 'handoff:complaint', JSON.stringify(d));
        });
    }
});

describe('prefilter: a request to stop is an opt-out', () => {
    const stops: [string, string][] = [
        ['whole message', 'stop'],
        ['whole message', 'STOP!!'],
        ['whole message', 'Stoooop'],
        ['whole message', 'stop please'],
        ['whole message', 'please stop'],
        ['whole message', 'وقف'],
        ['whole message', 'توقف من فضلك'],
        ['whole message', 'ستوب'],
        ['whole message', 'وقفوا لو سمحتوا'],
        ['phrase', 'توقفوا عن مراسلتي'],
        ['phrase', 'وقفوا الرسايل'],
        ['phrase', 'الغاء الاشتراك'],
        ['phrase', 'سيبني في حالي'],
        ['phrase', 'unsubscribe'],
        ['phrase', 'stop messaging me'],
        ['phrase', 'please leave me alone'],
        ['phrase', 'no more messages'],
        ['negation', 'لا تراسلني'],
        ['negation', 'لاتراسلني'],
        ['negation', 'لا تراسلوني بعد اليوم'],
        ['Gulf negation', 'ما ابي رسايل'],
        ['Gulf negation', 'ما ابغى اي رسائل منكم'],
        ['Gulf negation', 'لا تزعجني'],
        ['Egyptian negation', 'مش عايز رسايل'],
        ['Egyptian negation', 'متبعتليش تاني'],
        ['Egyptian negation', 'بطلوا تبعتولي رسايل'],
        ['English negation', 'don\'t message me again'],
        ['English negation', 'do not contact me'],
    ];
    for (const [shape, text] of stops) {
        it(`${shape}: ${text}`, () => {
            const d = prefilter(text);
            assert.equal(d.action, 'opt_out', JSON.stringify(d));
        });
    }
});

describe('prefilter: an insult is abuse', () => {
    const insults: [string, string][] = [
        ['Gulf', 'يا غبي'],
        ['Gulf', 'انت حمار'],
        ['Gulf', 'خرا عليكم'],
        ['Egyptian', 'يا حيوان'],
        ['Egyptian', 'زفت'],
        ['فصحى', 'أنتم حقيرون'],
        ['English', 'you idiot'],
        ['English', 'fuck you'],
        ['English', 'what a bitch'],
        ['English', 'shut up'],
    ];
    for (const [dialect, text] of insults) {
        it(`${dialect}: ${text}`, () => {
            const d = prefilter(text);
            assert.equal(kind(d), 'handoff:abuse', JSON.stringify(d));
        });
    }
});

describe('prefilter: what is said before the model passes', () => {
    // Each of these holds a word that is a keyword somewhere else. The model answers them.
    const passes: [string, string][] = [
        ['a question about the offer', 'كم سعر البرنامج؟'],
        ['a question about the level', 'هل يناسب المبتدئين؟'],
        ['asks for the link', 'ابغى الرابط'],
        ['a greeting', 'هلا والله'],
        ['English price', 'how much is it?'],
        ['stop inside a sentence', 'I can\'t stop thinking about this program'],
        ['stop as a question', 'كيف أوقف الاشتراك التجريبي؟'],
        ['stop as a question, Egyptian', 'ازاي أوقف التجديد؟'],
        ['a polite "silly question"', 'سؤال غبي بس هل يحتاج خبرة؟'],
        ['profanity as praise', 'this is fucking great'],
        ['"stupid" as self-deprecation', 'sorry if this is a stupid question'],
        ['not wanting to send', 'ما ابي ابعت رسالة الحين'],
        ['not sending the link', 'لا ترسل لي الرابط، عندي'],
        ['money, not mine', 'كيف أكسب فلوس من هذا المجال؟'],
        ['"no thanks"', 'لا شكراً'],
        ['a bug, not a complaint', 'عندي مشكلة في الكود'],
        ['a word that merely contains one', 'الاستعراض ممتاز'],
        ['emoji only', '🙏🙏'],
        ['punctuation only', '...'],
        ['empty', ''],
        ['blank', '   \n '],
    ];
    for (const [what, text] of passes) {
        it(`${what}: ${text}`, () => {
            assert.deepEqual(prefilter(text), { action: 'pass' });
        });
    }

    it('a message that is not text passes', () => {
        for (const bad of [undefined, null, 5, {}, [], ['stop']]) assert.deepEqual(prefilter(bad), { action: 'pass' });
    });

    it('reads no further than four thousand characters: a keyword past them is not looked for', () => {
        assert.equal(prefilter(`${'كلام '.repeat(1000)} refund`).action, 'pass');
        assert.equal(prefilter(`refund ${'كلام '.repeat(1000)}`).action, 'handoff');
    });
});

describe('prefilter: when a message says more than one thing', () => {
    it('refund, complaint, opt-out, abuse: in that order of precedence, and `also` lists the rest', () => {
        const refundAndStop = prefilter('ابي فلوسي ولا تراسلني');
        assert.equal(refundAndStop.action, 'handoff');
        assert.deepEqual(refundAndStop.action === 'handoff' && [refundAndStop.reason, refundAndStop.also], ['refund', ['opt_out']]);

        const complaintAndAbuse = prefilter('انتم نصابين يا حمير');
        assert.equal(complaintAndAbuse.action === 'handoff' && complaintAndAbuse.reason, 'complaint');
        assert.deepEqual(complaintAndAbuse.action === 'handoff' && complaintAndAbuse.also, ['abuse']);

        const stopAndAbuse = prefilter('stop messaging me you idiot');
        assert.equal(stopAndAbuse.action, 'opt_out');
        assert.deepEqual(stopAndAbuse.action === 'opt_out' && stopAndAbuse.also, ['abuse']);

        const everything = prefilter('refund this scam, stop messaging me, you idiot');
        assert.equal(everything.action === 'handoff' && everything.reason, 'refund');
        assert.deepEqual(everything.action === 'handoff' && everything.also, ['complaint', 'opt_out', 'abuse']);
    });

    it('an opt-out with nothing else is an opt-out with no `also`', () => {
        assert.deepEqual(prefilter('وقف'), { action: 'opt_out', matched: 'وقف', also: [] });
    });
});

describe('words: how a message is folded before it is read', () => {
    it('lower-cases, unifies Arabic letters, drops marks and tatweel, collapses stretched letters and apostrophes', () => {
        assert.deepEqual(words('Don\'t  STOOOP'), ['dont', 'stop']);
        assert.deepEqual(words('أُرِيدُ إسْتِرْجَاعَ'), ['اريد', 'استرجاع']);
        assert.deepEqual(words('فلوووسي!!! 🙏'), ['فلوسي']);
        assert.deepEqual(words('رسالة ٣'), ['رساله', '٣']);
    });
});
