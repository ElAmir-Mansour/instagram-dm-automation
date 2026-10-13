/**
 * "a" or "an" (`article.ts`): the article a prompt puts before a creator's role. The article follows the sound of the
 * first word, and the owner's own role must read as it does today.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { indefiniteArticle, withArticle } from './article.js';

describe('indefiniteArticle', () => {
    it('the owner\'s role reads as it does today', () => {
        assert.equal(withArticle('tech educator'), 'a tech educator');
    });

    it('a consonant sound takes "a", a vowel sound takes "an"', () => {
        for (const [phrase, article] of [
            ['fitness coach', 'a'], ['perfume shop', 'a'], ['coach', 'a'], ['yoga teacher', 'a'], ['wedding photographer', 'a'],
            ['online shop', 'an'], ['educator', 'an'], ['agency', 'an'], ['independent consultant', 'an'], ['artist', 'an'], ['umpire', 'an'],
        ] as const) assert.equal(indefiniteArticle(phrase), article, phrase);
    });

    it('a vowel letter said as a consonant takes "a"', () => {
        for (const phrase of ['university lecturer', 'user researcher', 'one-to-one coach', 'unicorn startup', 'European guide', 'utility expert']) {
            assert.equal(indefiniteArticle(phrase), 'a', phrase);
        }
    });

    it('a consonant letter said as a vowel (a silent h) takes "an"', () => {
        for (const phrase of ['hour-by-hour planner', 'honest reviewer', 'honor student tutor', 'heir coach']) {
            assert.equal(indefiniteArticle(phrase), 'an', phrase);
        }
        assert.equal(indefiniteArticle('hair stylist'), 'a');
        assert.equal(indefiniteArticle('history teacher'), 'a');
    });

    it('an acronym is read by the name of its first letter', () => {
        for (const [phrase, article] of [
            ['SEO consultant', 'an'], ['MBA mentor', 'an'], ['HR consultant', 'an'], ['AI coach', 'an'], ['NLP practitioner', 'an'], ['FAQ writer', 'an'],
            ['UX designer', 'a'], ['PMP trainer', 'a'], ['CEO coach', 'a'], ['UK tutor', 'a'], ['US immigration guide', 'a'],
        ] as const) assert.equal(indefiniteArticle(phrase), article, phrase);
    });

    it('a longer capitalised word is a word, and a brand that starts in lower case is read by its letter', () => {
        assert.equal(indefiniteArticle('STEM tutor'), 'a');
        assert.equal(indefiniteArticle('YOGA studio'), 'a');
        assert.equal(indefiniteArticle('iOS developer'), 'an');
        assert.equal(indefiniteArticle('eBay seller'), 'an');
        assert.equal(indefiniteArticle('Excel trainer'), 'an');
    });

    it('a lower-case acronym is read by its letter too, and an ordinary short word is not an acronym', () => {
        for (const [phrase, article] of [
            ['ux designer', 'a'], ['ui designer', 'a'], ['Ux designer', 'a'],
            ['seo consultant', 'an'], ['hr consultant', 'an'], ['mba mentor', 'an'], ['nlp coach', 'an'], ['sql trainer', 'an'], ['mma coach', 'an'], ['hvac technician', 'an'],
            // Words, not acronyms: "spa", "mom", "sun" and "hat" take the plain consonant rule.
            ['spa owner', 'a'], ['mom blogger', 'a'], ['sun-care brand', 'a'], ['hat maker', 'a'], ['art coach', 'an'],
        ] as const) assert.equal(indefiniteArticle(phrase), article, phrase);
        assert.equal(withArticle('ux designer'), 'a ux designer');
    });

    it('an X is "ex" before a consonant or alone and "z" before a vowel', () => {
        for (const [phrase, article] of [
            ['x-ray technician', 'an'], ['xray technician', 'an'], ['X-ray technician', 'an'], ['Xbox coach', 'an'], ['XML trainer', 'an'], ['xr developer', 'an'],
            ['xylophone teacher', 'a'], ['xenon lamp maker', 'a'], ['Xerox repairer', 'a'], ['xylitol brand', 'a'],
        ] as const) assert.equal(indefiniteArticle(phrase), article, phrase);
        assert.equal(withArticle('x-ray technician'), 'an x-ray technician');
        assert.equal(withArticle('xray technician'), 'an xray technician');
    });

    it('a number is read aloud', () => {
        assert.equal(indefiniteArticle('12-week coach'), 'a');
        assert.equal(indefiniteArticle('30-day challenge host'), 'a');
        assert.equal(indefiniteArticle('8-week coach'), 'an');
        assert.equal(indefiniteArticle('18-month mentor'), 'an');
        assert.equal(indefiniteArticle('11-plus tutor'), 'an');
    });

    it('ignores leading punctuation and case, and an empty phrase gets "a"', () => {
        assert.equal(indefiniteArticle('  "Online" shop'), 'an');
        assert.equal(indefiniteArticle('ONLINE SHOP'), 'an');
        assert.equal(indefiniteArticle(''), 'a');
        assert.equal(indefiniteArticle('   '), 'a');
        assert.equal(indefiniteArticle('---'), 'a');
    });

    it('withArticle trims the phrase and keeps its words as they are', () => {
        assert.equal(withArticle('  online shop '), 'an online shop');
        assert.equal(withArticle('UX designer'), 'a UX designer');
    });
});
