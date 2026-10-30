/**
 * The terms that bias a voice note's transcription (`keywords.ts`): at most twenty offer, course and brand names from the profile's DM context, longest first.
 * Pure: the contexts are the real ones the DM turn holds, cut from the fixtures profiles (`profile/fixtures.ts`), and nothing reaches a database or a model.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ASR_MAX_KEYWORDS } from '../llm/metaAsr.js';
import { contextFor } from '../profile/context.js';
import { FITNESS_EN, offer, SHOP_EG } from '../profile/fixtures.js';
import { KEYWORD_MAX_CHARS, voiceKeywords, type KeywordSource } from './keywords.js';

const source = (over: { offers?: KeywordSource['offers']; brand?: string; ar?: string; en?: string } = {}): KeywordSource => ({
    names: { display_name: { ar: over.ar ?? '', en: over.en ?? '' }, brand_name: over.brand ?? '' },
    offers: over.offers ?? [],
});
const named = (...names: string[]): KeywordSource['offers'] => names.map((name) => ({ name }));
const length = (text: string): number => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;

describe('voiceKeywords on the profiles the DM turn really holds', () => {
    it('an English coach: both offers, the brand name and the display name, longest first', () => {
        const ctx = contextFor(FITNESS_EN, 'dm', null);
        assert.deepEqual(voiceKeywords(ctx), ['Twelve-week plan', 'One-to-one call', 'Sami Fitness', 'Sami Fit']);
    });

    it('an Egyptian shop with no brand name: its two products and its display names in both languages (the display name is the only brand it has)', () => {
        const ctx = contextFor(SHOP_EG, 'dm', null);
        assert.equal(ctx.names.brand_name, '');
        assert.deepEqual(voiceKeywords(ctx), ['شمعة لافندر', 'علبة هدية', 'Nour Shop', 'متجر نور']);
    });

    it('is what the context gives and never its comment keywords or its handle: the words a post asks people to comment are not names, and are often everyday words', () => {
        const ctx = contextFor(FITNESS_EN, 'dm', null);
        const out = voiceKeywords(ctx);
        for (const offerOfCtx of ctx.offers) assert.ok(offerOfCtx.keyword && !out.includes(offerOfCtx.keyword), offerOfCtx.keyword);
        assert.ok(!out.includes(ctx.links.handle));
        assert.ok(!out.some((t) => t.includes('@')));
    });
});

describe('voiceKeywords: which names, and in what order', () => {
    it('lists the longest first (by what a reader sees: an Arabic letter and its marks count once)', () => {
        const out = voiceKeywords(source({ offers: named('Go', 'Agentic AI for beginners', 'Python', 'كورس الذكاء الاصطناعي') }));
        assert.deepEqual(out, ['Agentic AI for beginners', 'كورس الذكاء الاصطناعي', 'Python', 'Go']);
        // A diacritic does not make a name longer: «مُحَمَّد» is four letters.
        assert.deepEqual(voiceKeywords(source({ offers: named('مُحَمَّد', 'abcde') })), ['abcde', 'مُحَمَّد']);
    });

    it('breaks a tie in the order the profile gives the names, the primary offer first, then the others, the brand name, and the display names Arabic then English', () => {
        const out = voiceKeywords(source({
            offers: [{ name: 'bbbb' }, { name: 'aaaa', primary: true }, { name: 'cccc' }],
            brand: 'dddd', ar: 'eeee', en: 'ffff',
        }));
        assert.deepEqual(out, ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee', 'ffff']);
    });

    it('drops a name that repeats one already kept, ignoring case, width and spacing, and keeps the first spelling', () => {
        const out = voiceKeywords(source({
            offers: named('AutoReply Pro', 'autoreply pro', 'Agentic   AI', 'Agentic AI'),
            // Full-width letters are the same name once normalised.
            brand: 'AUTOREPLY PRO', en: '\uFF21gentic \uFF21\uFF29',
        }));
        assert.deepEqual(out, ['AutoReply Pro', 'Agentic AI']);
    });

    it('drops what is blank or not text, and cleans what is left to one line with no control or direction-changing character', () => {
        const out = voiceKeywords(source({
            offers: [{ name: '   ' }, { name: '' }, { name: 7 as unknown as string }, { name: null as unknown as string }, { name: 'Agentic‮ AI\n course\t' }],
            brand: '​', ar: undefined, en: ' ',
        }));
        assert.deepEqual(out, ['Agentic AI course']);
    });

    it('is empty for a profile with nothing named, and never throws', () => {
        assert.deepEqual(voiceKeywords(source()), []);
    });
});

describe('voiceKeywords: how many, and how long', () => {
    it('sends at most twenty, and when there are more the LONGEST twenty (the most specific, the least likely to be a common word), still longest first', () => {
        const names = Array.from({ length: 30 }, (_, i) => 'n'.repeat(i + 1));
        const out = voiceKeywords(source({ offers: named(...names) }));
        assert.equal(ASR_MAX_KEYWORDS, 20);
        assert.equal(out.length, 20);
        assert.deepEqual(out.map((t) => t.length), Array.from({ length: 20 }, (_, i) => 30 - i));
        assert.ok(!out.includes('n'.repeat(10)), 'the shortest ten were left out');
    });

    it('cuts a name over 80 characters at a word (the start of a title is the part a person says), with no ellipsis and no trailing space', () => {
        const title = 'Agentic AI: build real AI agents from scratch, with Claude, tools and memory, step by step';
        assert.ok(title.length > KEYWORD_MAX_CHARS);
        const [out] = voiceKeywords(source({ offers: named(title) }));
        assert.equal(out, 'Agentic AI: build real AI agents from scratch, with Claude, tools and memory');
        assert.ok(length(out!) <= KEYWORD_MAX_CHARS);
        assert.doesNotMatch(out!, /[\s,;:…-]$/, 'no trailing space, separator or ellipsis');
    });

    it('cuts a single word that is longer than the limit where it stands', () => {
        const [out] = voiceKeywords(source({ offers: named('x'.repeat(200)) }));
        assert.equal(out, 'x'.repeat(KEYWORD_MAX_CHARS));
    });

    it('keeps a name of exactly the limit whole, and counts Arabic by what is seen', () => {
        const eighty = 'ا'.repeat(80);
        assert.equal(voiceKeywords(source({ offers: named(eighty) }))[0], eighty);
        assert.equal(voiceKeywords(source({ offers: named('ا'.repeat(81)) }))[0], eighty);
    });

    it('every term is at most 80 characters, whatever the profile holds (an offer\'s name may be 200)', () => {
        const out = voiceKeywords(source({ offers: named(...Array.from({ length: 10 }, (_, i) => `title ${i} ${'word '.repeat(40)}`)), brand: 'B'.repeat(80) }));
        assert.ok(out.length > 0);
        for (const term of out) assert.ok(length(term) <= KEYWORD_MAX_CHARS, `${length(term)}: ${term}`);
    });
});

describe('voiceKeywords: it changes nothing it is given', () => {
    it('leaves the context\'s offers in their order, and returns a list nothing else holds', () => {
        const ctx = contextFor(FITNESS_EN, 'dm', null);
        const before = JSON.stringify(ctx);
        const first = voiceKeywords(ctx);
        assert.equal(JSON.stringify(ctx), before);
        first.push('mutated');
        assert.ok(!voiceKeywords(ctx).includes('mutated'));
    });

    it('works on a frozen profile', () => {
        const frozen = Object.freeze({
            names: Object.freeze({ display_name: Object.freeze({ ar: 'أمير', en: 'Amir' }), brand_name: 'ElAmir' }),
            offers: Object.freeze([Object.freeze(offer({ id: 'a', name: 'Agentic AI', primary: true })), Object.freeze(offer({ id: 'b', name: 'C#' }))]),
        });
        assert.deepEqual(voiceKeywords(frozen), ['Agentic AI', 'ElAmir', 'أمير', 'Amir', 'C#']);
    });
});
