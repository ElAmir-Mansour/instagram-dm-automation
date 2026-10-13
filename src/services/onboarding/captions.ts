/**
 * Which of a creator's posts may be shown as an example of how they write (docs/onboarding/03 §3.3). Code builds the
 * pool, the model picks 3 to 5 ids from it with a reason each, and code copies the verbatim text by id. Pure.
 *
 *   1. Captions under 60 characters, once hashtags, mentions and URLs are taken out, are dropped: a hashtag block
 *      or a tagged friend is not writing.
 *   2. Reposts are removed: two captions whose word sets overlap at Jaccard 0.8 or more are one post, and the one
 *      that did better is kept.
 *   3. Each candidate is tagged with its engagement percentile and its media type.
 *
 * The percentile is of the post among ALL the creator's fetched posts whose likes are visible (a short caption that
 * went viral still shapes what "did well" means for this account), by likes plus comments. It is `null` when this
 * post hides its likes, and for every post when fewer than three are measurable: a rank among two is noise.
 */
import { normalizeArabic } from '../../utils/arabic.js';
import type { SampleCandidate } from './draftSignals.js';
import { SOURCE_CAPS, sanitizeSourceText } from './fence.js';
import { charLength } from './textClean.js';

/** What a post must have for the pool: its id is the id of the `ig_caption` source that holds its text. */
export interface CaptionPost {
    id: string;
    caption: string | null;
    /** `IMAGE`, `VIDEO` or `CAROUSEL_ALBUM`. */
    mediaType: string | null;
    /** `FEED`, `REELS`, `STORY` or `AD`: a video is a Reel when this says so. */
    productType: string | null;
    /** `null` when the creator hides likes. */
    likeCount: number | null;
    commentsCount: number | null;
}

export const MIN_CANDIDATE_CHARS = 60;
/** Fewer words than this is no sample of a voice (an emoji row passes 60 characters). */
export const MIN_CANDIDATE_WORDS = 3;
export const REPOST_JACCARD = 0.8;
/** Fewer measurable posts than this and a percentile is not given. */
export const MIN_RANKED_POSTS = 3;
export const MAX_CANDIDATES = 30;

const HASHTAG = /#[\p{L}\p{M}\p{N}_]+/gu;
const MENTION = /@[\p{L}\p{N}_.]+/gu;
const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+/giu;

/** The caption without its hashtags, mentions and URLs, on one line: what is left is what they wrote. */
export function stripCaptionNoise(caption: string): string {
    return caption.replace(URL_LIKE, ' ').replace(HASHTAG, ' ').replace(MENTION, ' ').replace(/\s+/g, ' ').trim();
}

/** The words of a text for comparing two captions: normalised Arabic, split on anything that is not a letter or a digit. */
export function captionWords(text: string): Set<string> {
    return new Set(normalizeArabic(text).split(/[^\p{L}\p{N}_]+/u).filter(Boolean));
}

/** |a ∩ b| / |a ∪ b|, 0 when both are empty. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let shared = 0;
    for (const word of a) if (b.has(word)) shared++;
    return shared / (a.size + b.size - shared);
}

/** Likes plus comments, or null when the likes are hidden (a missing comment count is 0). */
export function engagementOf(post: Pick<CaptionPost, 'likeCount' | 'commentsCount'>): number | null {
    return post.likeCount === null ? null : post.likeCount + (post.commentsCount ?? 0);
}

/**
 * The percentile (0 to 100, whole numbers) of each post among those with visible likes: the share of them it beats, with
 * a tie counting half, so the best of thirty is 98 and not 100. Null for a post with hidden likes, and for all of them when
 * fewer than `MIN_RANKED_POSTS` are measurable.
 */
export function engagementPercentiles(posts: readonly CaptionPost[]): Map<string, number | null> {
    const scores = posts.map((p) => engagementOf(p)).filter((e): e is number => e !== null);
    const out = new Map<string, number | null>();
    for (const post of posts) {
        const e = engagementOf(post);
        if (e === null || scores.length < MIN_RANKED_POSTS) {
            out.set(post.id, null);
            continue;
        }
        const below = scores.filter((s) => s < e).length;
        const equal = scores.filter((s) => s === e).length;
        out.set(post.id, Math.round((100 * (below + equal / 2)) / scores.length));
    }
    return out;
}

/** `REELS` for a Reel, else the media type (`IMAGE`, `VIDEO`, `CAROUSEL_ALBUM`), else `UNKNOWN`. */
export function mediaTag(post: Pick<CaptionPost, 'mediaType' | 'productType'>): string {
    if (post.productType === 'REELS') return 'REELS';
    return post.mediaType || 'UNKNOWN';
}

export interface PickOptions {
    /** At most this many candidates (default 30). */
    max?: number;
}

/**
 * The pool the model picks samples from (03 §3.3), in the order the posts came in (newest first, from Instagram). Reposts
 * keep their best-engaged copy; of two equal ones the earlier in the input wins.
 */
export function pickSampleCandidates(posts: readonly CaptionPost[], opts: PickOptions = {}): SampleCandidate[] {
    const max = Math.max(0, opts.max ?? MAX_CANDIDATES);
    const percentiles = engagementPercentiles(posts);

    interface Entry { index: number; post: CaptionPost; text: string; words: Set<string>; score: number }
    const entries: Entry[] = [];
    posts.forEach((post, index) => {
        if (typeof post.caption !== 'string') return;
        const text = sanitizeSourceText(post.caption, SOURCE_CAPS.ig_caption);
        const stripped = stripCaptionNoise(text);
        if (charLength(stripped) < MIN_CANDIDATE_CHARS) return;
        const words = captionWords(stripped);
        if (words.size < MIN_CANDIDATE_WORDS) return;
        entries.push({ index, post, text, words, score: percentiles.get(post.id) ?? -1 });
    });

    const kept: Entry[] = [];
    for (const entry of [...entries].sort((a, b) => b.score - a.score || a.index - b.index)) {
        if (kept.some((other) => jaccard(entry.words, other.words) >= REPOST_JACCARD)) continue;
        kept.push(entry);
    }

    return kept
        .sort((a, b) => a.index - b.index)
        .slice(0, max)
        .map((e): SampleCandidate => ({
            id: e.post.id,
            media_type: mediaTag(e.post),
            engagement_percentile: percentiles.get(e.post.id) ?? null,
            chars: charLength(e.text),
        }));
}
