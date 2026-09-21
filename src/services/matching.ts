/**
 * Campaign keyword matching.
 *
 * This lived inline in the webhook handler, which meant the only test of it —
 * `scripts/test-enhancements.ts` — had to *re-implement* the logic to test it. The copy and
 * the original were free to drift, so a green test proved nothing about production. This
 * module is the single definition both now import.
 *
 * Matching normalises both sides with `normalizeArabic` and then tests each keyword according
 * to the campaign's own `match_mode`. Substring matching is what makes short keywords
 * dangerous (`تم` matches inside اهتمام, تمام, يتم); `'word'` anchors the keyword to token
 * boundaries instead. `'substring'` remains the default everywhere — including for a row whose
 * query forgot to select the column — because changing it implicitly would silently stop live
 * campaigns from firing.
 */
import { normalizeArabic, keywordMatches, normalizeMatchMode } from '../utils/arabic.js';

/** The fields matching actually reads. Rows carry far more; generics preserve the rest. */
export interface CampaignMatchFields {
    trigger_keyword: string;
    post_id?: string | null;
    is_active?: boolean;
    created_at?: string | Date | null;
    /**
     * `'word'` requires the keyword to sit on a token boundary; anything else (including
     * absent, which is what a query that does not select the column yields) means substring.
     */
    match_mode?: string | null;
}

function toTime(value: string | Date | null | undefined): number {
    if (!value) return 0;
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Most specific campaign first.
 *
 * Mirrors the `ORDER BY` the webhook's campaign query now carries, so a caller that hands us
 * an arbitrarily ordered array (a unit test, a cached list) gets the same winner the database
 * path does. Without this a generic campaign could shadow a post-specific one on the same
 * keyword, and which one won could change after a VACUUM reordered the heap.
 */
function bySpecificity(a: CampaignMatchFields, b: CampaignMatchFields): number {
    return (
        (b.post_id ? 1 : 0) - (a.post_id ? 1 : 0) ||
        b.trigger_keyword.length - a.trigger_keyword.length ||
        toTime(b.created_at) - toTime(a.created_at)
    );
}

/**
 * Pick the campaign a comment triggers, or null.
 *
 * `trigger_keyword` is a comma-separated list; any one of them matching is enough.
 * A campaign with `post_id` set only fires on that post; one without fires on any.
 */
export function matchCampaign<T extends CampaignMatchFields>(
    commentText: string,
    postId: string,
    campaigns: T[]
): T | null {
    const normalizedCommentText = normalizeArabic(commentText);
    if (!normalizedCommentText) return null;

    // Copy before sorting — the caller's array (a query result, possibly reused) is not ours.
    const ranked = [...campaigns].sort(bySpecificity);

    const matched = ranked.find((c) => {
        // The webhook filters on is_active in SQL; callers that do not (tests) get the same
        // answer from here.
        if (c.is_active === false) return false;

        const triggerKeywordsList = c.trigger_keyword
            .split(',')
            .map((k: string) => normalizeArabic(k.trim()))
            .filter(Boolean);

        // The campaign's own mode, defaulting to 'substring' — the historical behaviour, kept
        // so a campaign created before v14 keeps firing exactly as it does today.
        const mode = normalizeMatchMode(c.match_mode);
        const hasKeyword = triggerKeywordsList.some((normalizedKeyword: string) =>
            keywordMatches(normalizedCommentText, normalizedKeyword, mode)
        );

        // If post_id filter is set, it must match the current comment's post_id
        const postIdMatches = !c.post_id || c.post_id === postId;

        return hasKeyword && postIdMatches;
    });

    return matched ?? null;
}
