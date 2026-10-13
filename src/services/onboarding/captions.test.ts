/**
 * The sample pool (03 §3.3): short captions out, reposts out, each candidate tagged with its percentile and its media type.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    MIN_CANDIDATE_CHARS, engagementOf, engagementPercentiles, jaccard, mediaTag, pickSampleCandidates, stripCaptionNoise, captionWords,
    type CaptionPost,
} from './captions.js';
import { ENGLISH, GULF } from './fixtures/captions.js';

const post = (id: string, caption: string | null, over: Partial<CaptionPost> = {}): CaptionPost => ({
    id, caption, mediaType: 'IMAGE', productType: 'FEED', likeCount: 10, commentsCount: 0, ...over,
});

const LONG_A = 'وش رايك نبدأ من اليوم؟ الحين الوقت المناسب لتتعلم البرمجة من الصفر مع التدريب اليومي';
const LONG_B = 'Most beginners quit because the plan is too big, so make it small and make it daily and results follow';

describe('stripCaptionNoise', () => {
    it('takes out hashtags, mentions and links, in Arabic and English, and folds the rest to one line', () => {
        const out = stripCaptionNoise('تجربة العطر الجديد #عطور #perfume @noor.shop https://noor.example/p?x=1\nwww.noor.example/y  رائع');
        assert.equal(out, 'تجربة العطر الجديد رائع');
        assert.equal(stripCaptionNoise('#a #b #c'), '');
    });
});

describe('pickSampleCandidates: what is dropped', () => {
    it('drops a caption under 60 characters once hashtags, mentions and URLs are removed', () => {
        const hashtagsOnly = `قصير #${'عطور'}_${'x'.repeat(30)} #${'y'.repeat(30)} #${'z'.repeat(30)}`;
        const mentionPadded = `شكرا لكم @${'a'.repeat(30)} @${'b'.repeat(30)} https://example.com/${'c'.repeat(30)}`;
        const posts = [post('p1', hashtagsOnly), post('p2', mentionPadded), post('p3', LONG_A), post('p4', null), post('p5', '')];
        assert.deepEqual(pickSampleCandidates(posts).map((c) => c.id), ['p3']);
    });

    it('keeps a caption of exactly 60 characters and drops one of 59', () => {
        const sixty = 'abcde fghij klmno pqrst uvwxy zabcd efghi jklmn opqrs tuvwx '.trim().padEnd(MIN_CANDIDATE_CHARS, 'q');
        assert.equal([...sixty].length, MIN_CANDIDATE_CHARS);
        assert.equal(pickSampleCandidates([post('a', sixty)]).length, 1);
        assert.equal(pickSampleCandidates([post('a', sixty.slice(0, -1))]).length, 0);
    });

    it('counts characters, not UTF-16 units: sixty Arabic letters and a row of emoji are told apart', () => {
        const words = Array.from({ length: 12 }, (_, i) => `كلمة${'ا'.repeat(i % 3)}`).join(' ');
        assert.ok(pickSampleCandidates([post('a', words)]).length === 1);
        const emojiRow = '🔥'.repeat(70);
        assert.equal(pickSampleCandidates([post('b', emojiRow)]).length, 0, 'a row of emoji is no sample of how they write');
    });

    it('drops reposts: two captions at Jaccard 0.8 or more are one post', () => {
        const same = post('p1', LONG_A);
        const repost = post('p2', `${LONG_A} 🌹`);
        const other = post('p3', LONG_B);
        assert.deepEqual(pickSampleCandidates([same, repost, other]).map((c) => c.id), ['p1', 'p3']);
    });

    it('sees through Arabic spelling variants when it compares: hamza, teh marbuta, yeh, diacritics, tatweel', () => {
        const a = post('p1', 'أحب القراءة كل يوم لأنها تعلمنا الصبر والتأمل وتفتح لنا آفاقا جديدة في الحياة');
        const b = post('p2', 'احب القراءه كل يوم لانها تعلمنا الصبر والتأمل وتفتح لنا افاقا جديده في الحياه');
        assert.equal(jaccard(captionWords(a.caption!), captionWords(b.caption!)), 1);
        assert.deepEqual(pickSampleCandidates([a, b]).map((c) => c.id), ['p1']);
    });

    it('keeps two captions that share a topic but not their words (Jaccard under 0.8)', () => {
        const a = post('p1', 'تعلم البرمجة من الصفر خطوة بخطوة مع مشاريع عملية صغيرة كل أسبوع حتى تتقن الأساسيات');
        const b = post('p2', 'تعلم البرمجة بالتدريب اليومي والصبر وحل المسائل الصعبة حتى تصل إلى مستوى الاحتراف');
        assert.ok(jaccard(captionWords(a.caption!), captionWords(b.caption!)) < 0.8);
        assert.equal(pickSampleCandidates([a, b]).length, 2);
    });

    it('is case-insensitive in English and ignores hashtags and links when it compares', () => {
        const a = post('p1', `${LONG_B} #fitness https://a.example/1`);
        const b = post('p2', `${LONG_B.toUpperCase()} #motivation https://b.example/2`);
        assert.deepEqual(pickSampleCandidates([a, b]).map((c) => c.id), ['p1']);
    });

    it('keeps the better-engaged copy of a repost, and the earlier of two equal ones', () => {
        const posts = [
            post('new', LONG_A, { likeCount: 5 }),
            post('mid', LONG_B, { likeCount: 50 }),
            post('old', LONG_A, { likeCount: 500 }),
            post('oldest', LONG_B, { likeCount: 50 }),
        ];
        const ids = pickSampleCandidates(posts).map((c) => c.id);
        assert.deepEqual(ids, ['mid', 'old'], 'the order of the input is kept; of the A reposts the one with 500 likes stays');
    });
});

describe('pickSampleCandidates: what is kept', () => {
    it('tags each candidate with its id, media type, percentile and the length of its caption', () => {
        const posts = [
            post('p1', LONG_A, { mediaType: 'VIDEO', productType: 'REELS', likeCount: 900 }),
            post('p2', LONG_B, { mediaType: 'CAROUSEL_ALBUM', likeCount: 100 }),
            post('p3', 'خمسة أسباب تجعل البرمجة مهنة المستقبل في العالم العربي وكيف تبدأ بها اليوم وليس غدا', { likeCount: 300 }),
        ];
        const out = pickSampleCandidates(posts);
        assert.deepEqual(out.map((c) => [c.id, c.media_type, c.engagement_percentile]), [['p1', 'REELS', 83], ['p2', 'CAROUSEL_ALBUM', 17], ['p3', 'IMAGE', 50]]);
        assert.equal(out[0]!.chars, [...LONG_A].length);
    });

    it('keeps the order the posts came in (newest first) and honours a limit', () => {
        const posts = Array.from({ length: 6 }, (_, i) => post(`p${i + 1}`, `${GULF[i % GULF.length]} رقم ${'ا'.repeat(i + 1)} ${'كلمة'.repeat(i + 1)}`, { likeCount: i * 7 }));
        const all = pickSampleCandidates(posts).map((c) => c.id);
        assert.deepEqual(all, [...all].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
        assert.equal(pickSampleCandidates(posts, { max: 2 }).length, 2);
        assert.equal(pickSampleCandidates(posts, { max: 0 }).length, 0);
    });

    it('is empty for no posts, and for posts with no captions', () => {
        assert.deepEqual(pickSampleCandidates([]), []);
        assert.deepEqual(pickSampleCandidates([post('a', null), post('b', '')]), []);
    });

    it('takes the Arabic register fixtures through whole: the Gulf and English sets keep what is long enough', () => {
        const gulf = pickSampleCandidates(GULF.map((c, i) => post(`p${i + 1}`, c)));
        assert.ok(gulf.length >= 4 && gulf.every((c) => c.chars >= MIN_CANDIDATE_CHARS));
        const english = pickSampleCandidates(ENGLISH.map((c, i) => post(`p${i + 1}`, c)));
        assert.equal(english.length, ENGLISH.length);
    });

    it('does not change the posts it is given', () => {
        const posts = [post('p1', LONG_A), post('p2', LONG_A)];
        const before = JSON.stringify(posts);
        pickSampleCandidates(posts);
        assert.equal(JSON.stringify(posts), before);
    });
});

describe('engagement', () => {
    it('is likes plus comments, null when likes are hidden, and a missing comment count is zero', () => {
        assert.equal(engagementOf({ likeCount: 10, commentsCount: 5 }), 15);
        assert.equal(engagementOf({ likeCount: 10, commentsCount: null }), 10);
        assert.equal(engagementOf({ likeCount: null, commentsCount: 50 }), null);
    });

    it('ranks a post among those with visible likes: the share it beats, a tie counting half', () => {
        const posts = ['a', 'b', 'c', 'd', 'e'].map((id, i) => post(id, null, { likeCount: (i + 1) * 10, commentsCount: 0 }));
        const p = engagementPercentiles(posts);
        assert.deepEqual([...p.values()], [10, 30, 50, 70, 90]);
        const tied = engagementPercentiles([post('a', null, { likeCount: 5 }), post('b', null, { likeCount: 5 }), post('c', null, { likeCount: 9 }), post('d', null, { likeCount: 1 })]);
        assert.deepEqual([tied.get('a'), tied.get('b'), tied.get('c'), tied.get('d')], [50, 50, 88, 13]);
    });

    it('gives the best of thirty 98, not 100', () => {
        const posts = Array.from({ length: 30 }, (_, i) => post(`p${i}`, null, { likeCount: i }));
        assert.equal(engagementPercentiles(posts).get('p29'), 98);
        assert.equal(engagementPercentiles(posts).get('p0'), 2);
    });

    it('is null for a post with hidden likes, and for every post when fewer than three are measurable', () => {
        const hidden = engagementPercentiles([post('a', null, { likeCount: 1 }), post('b', null, { likeCount: 2 }), post('c', null, { likeCount: 3 }), post('h', null, { likeCount: null })]);
        assert.equal(hidden.get('h'), null);
        assert.notEqual(hidden.get('a'), null);
        const few = engagementPercentiles([post('a', null, { likeCount: 1 }), post('b', null, { likeCount: 2 }), post('h', null, { likeCount: null })]);
        assert.deepEqual([...few.values()], [null, null, null]);
    });

    it('measures a short caption that went viral too, because the percentile is among all the posts', () => {
        const posts = [
            post('viral', '🔥', { likeCount: 10_000 }),
            post('a', LONG_A, { likeCount: 100 }),
            post('b', LONG_B, { likeCount: 200 }),
            post('c', 'Make it small and make it daily, and the results will follow without fail every single time', { likeCount: 300 }),
        ];
        const out = pickSampleCandidates(posts);
        assert.deepEqual(out.map((c) => [c.id, c.engagement_percentile]), [['a', 13], ['b', 38], ['c', 63]]);
    });
});

describe('mediaTag', () => {
    it('says REELS for a Reel, else the media type, else UNKNOWN', () => {
        assert.equal(mediaTag({ mediaType: 'VIDEO', productType: 'REELS' }), 'REELS');
        assert.equal(mediaTag({ mediaType: 'VIDEO', productType: 'FEED' }), 'VIDEO');
        assert.equal(mediaTag({ mediaType: 'CAROUSEL_ALBUM', productType: null }), 'CAROUSEL_ALBUM');
        assert.equal(mediaTag({ mediaType: null, productType: null }), 'UNKNOWN');
    });
});

describe('jaccard', () => {
    it('is the shared share of the union', () => {
        assert.equal(jaccard(new Set(['a', 'b', 'c', 'd']), new Set(['a', 'b', 'c', 'e'])), 3 / 5);
        assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
        assert.equal(jaccard(new Set(['a']), new Set(['a'])), 1);
        assert.equal(jaccard(new Set(), new Set()), 0, 'two empty captions are not the same post');
    });
});
