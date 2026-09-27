/**
 * The Marketer's copy rules found wanting on the first live reel (2026-09-27): generic hashtags,
 * a TikTok caption that said "link in bio" twice, and an opening that narrated the screen.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanHashtags, termTags, withoutBioLink } from './copy.js';
import { leaningOpening } from './transcript.js';

describe('the Marketer\'s hashtags', () => {
    it('drops generic tags when the clip has real topic tags, and adds the tools its title names', () => {
        const tags = cleanHashtags(['تقنية', 'تطوير', 'برمجة', 'تعلم', 'الذكاء_الاصطناعي'], undefined, [], termTags('نتيجة تخصيص ردود Gemini عملياً'));
        assert.deepEqual(tags, ['Gemini', 'الذكاء_الاصطناعي']);
    });

    it('keeps generic tags when nothing better is there, rather than posting none', () => {
        assert.deepEqual(cleanHashtags(['تقنية', 'تعلم']), ['تقنية', 'تعلم']);
    });

    it('reads tools, not filler, from Latin words', () => {
        assert.deepEqual(termTags('How to use ChatGPT and Gemini with n8n'), ['ChatGPT', 'Gemini', 'n8n']);
        assert.deepEqual(termTags('خلي الـ Agent يكتب الـ prompt'), []);
    });
});

describe('the TikTok body', () => {
    it('loses its own "link in bio", which the tenant\'s TikTok line adds', () => {
        assert.equal(withoutBioLink('طريقة عملية لتخصيص ردود Gemini بالكامل حسب احتياجك، ورابطه في البايو.'), 'طريقة عملية لتخصيص ردود Gemini بالكامل حسب احتياجك.');
        assert.equal(withoutBioLink('The full guide, link in bio.'), 'The full guide.');
        assert.equal(withoutBioLink('بدون رابط هنا'), 'بدون رابط هنا');
    });
});

describe('openings that narrate the screen', () => {
    it('are refused like any opening that needs what came before', () => {
        assert.equal(leaningOpening('هني جينا محادثة جديدة هقولوا مثلا'), 'هني جينا');
        assert.ok(leaningOpening('كما نرى في موقعنا'), 'normalised, so ى and ي both match');
        assert.equal(leaningOpening('Gemini يرد عليك بالعربي'), null);
    });
});
