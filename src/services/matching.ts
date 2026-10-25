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
import { normalizeArabic, keywordMatches, normalizeMatchMode, type KeywordMatchMode } from '../utils/arabic.js';

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
 * How two campaigns compare, tier by tier: [post-specific, keyword-list length, newest].
 * Each entry is negative when `a` ranks ahead of `b` on that tier, positive when `b` does, and
 * 0 when the tier does not separate them. `bySpecificity` reads the first non-zero tier, and
 * `winReason` names it, so the ranking and the explanation of the ranking are one expression.
 */
function specificityTiers(a: CampaignMatchFields, b: CampaignMatchFields): [number, number, number] {
    return [
        (b.post_id ? 1 : 0) - (a.post_id ? 1 : 0),
        b.trigger_keyword.length - a.trigger_keyword.length,
        toTime(b.created_at) - toTime(a.created_at),
    ];
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
    const [post, list, newest] = specificityTiers(a, b);
    return post || list || newest;
}

/** One entry of a trigger list: as the owner typed it, and as matching sees it. */
export interface TriggerKeyword {
    typed: string;
    normalized: string;
}

/**
 * `trigger_keyword` is a comma-separated list; this is the list.
 *
 * Both commas: an operator on an Arabic keyboard types «،», and the dashboard's placeholder
 * shows it. Splitting on ASCII only turned «سعر، رابط» into one dead phrase keyword that fired
 * on nothing. An entry that normalises to nothing (a lone tatweel, a bare diacritic) is
 * dropped, because an empty keyword is a substring of everything.
 */
export function triggerKeywords(trigger: string): TriggerKeyword[] {
    return trigger
        .split(/[,،]/)
        .map((k: string) => k.trim())
        .map((typed) => ({ typed, normalized: normalizeArabic(typed) }))
        .filter((k) => k.normalized);
}

/** Why a campaign did not fire on a comment, the first reason that applies. */
export type MissReason = 'no_keyword' | 'word_mode' | 'other_post' | 'paused';

/** What one campaign makes of one comment. */
export interface CampaignVerdict {
    fires: boolean;
    /** The first keyword of the list that fires, in the campaign's own mode. */
    matched: TriggerKeyword | null;
    /** Set when the campaign did not fire. */
    miss: MissReason | null;
    /**
     * In word mode: the first keyword that sits inside a longer word of the comment and so did
     * not fire. Never set in substring mode, which accepts the keyword anywhere.
     */
    nearMiss: TriggerKeyword | null;
}

/**
 * The rule, for one campaign and one (already normalised) comment. `matchCampaign` and
 * `rankMatches` both decide through this, so the live webhook and the dry run cannot disagree
 * about whether a campaign fires.
 */
export function judgeCampaign(
    normalizedText: string, postId: string, c: CampaignMatchFields
): CampaignVerdict {
    const keywords = triggerKeywords(c.trigger_keyword);

    // The campaign's own mode, defaulting to 'substring' — the historical behaviour, kept
    // so a campaign created before v14 keeps firing exactly as it does today.
    const mode = normalizeMatchMode(c.match_mode);
    const matched = keywords.find((k) => keywordMatches(normalizedText, k.normalized, mode)) ?? null;
    const nearMiss = matched || mode !== 'word'
        ? null
        : keywords.find((k) => keywordMatches(normalizedText, k.normalized, 'substring')) ?? null;

    // If post_id filter is set, it must match the current comment's post_id
    const postIdMatches = !c.post_id || c.post_id === postId;

    // The webhook filters on is_active in SQL; callers that do not (tests) get the same
    // answer from here.
    const active = c.is_active !== false;

    const fires = active && matched !== null && postIdMatches;
    let miss: MissReason | null = null;
    if (!fires) {
        miss = !matched ? (nearMiss ? 'word_mode' : 'no_keyword') : !postIdMatches ? 'other_post' : 'paused';
    }
    return { fires, matched, miss, nearMiss };
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

    const matched = ranked.find((c) => judgeCampaign(normalizedCommentText, postId, c).fires);

    return matched ?? null;
}

/** A campaign that fires on a comment, with the keyword that made it fire. */
export interface FiringCampaign<T> {
    campaign: T;
    matched: TriggerKeyword;
}

/**
 * Every campaign that fires on a comment, in the order `matchCampaign` picks from: the first is
 * the one the webhook answers with. The dry run (`POST /campaigns/try`) reads the rest to say
 * what the winner beat.
 */
export function rankMatches<T extends CampaignMatchFields>(
    commentText: string,
    postId: string,
    campaigns: readonly T[]
): FiringCampaign<T>[] {
    const normalizedCommentText = normalizeArabic(commentText);
    if (!normalizedCommentText) return [];

    const out: FiringCampaign<T>[] = [];
    for (const campaign of [...campaigns].sort(bySpecificity)) {
        const verdict = judgeCampaign(normalizedCommentText, postId, campaign);
        if (verdict.fires && verdict.matched) out.push({ campaign, matched: verdict.matched });
    }
    return out;
}

/**
 * Why the first of two firing campaigns outranks the second: the first tier of the ranking that
 * separates them.
 *
 *   post_specific  one is tied to a post and the other answers every post
 *   longer_list    the stored keyword list is longer (its length in characters, not its count)
 *   newest         created later
 *   tie            identical on all three; the database's row order decides, which is not stable
 */
export type WinReason = 'post_specific' | 'longer_list' | 'newest' | 'tie';

export function winReason(winner: CampaignMatchFields, runnerUp: CampaignMatchFields): WinReason {
    const [post, list, newest] = specificityTiers(winner, runnerUp);
    return post ? 'post_specific' : list ? 'longer_list' : newest ? 'newest' : 'tie';
}

/** One trigger that would fire alongside a live one on a comment meant for one of them. */
export interface TriggerClash {
    /** The new trigger, as given. */
    trigger: string;
    /** The live trigger it collides with, as the campaign stores it. */
    live: string;
}

/**
 * The real collisions between new triggers — a campaign about to be created with `mode` — and the
 * live campaigns for every post, judged by each side's own match mode rather than by spelling.
 *
 * Two triggers collide when a comment of one would fire the other too: the new trigger fires on
 * the live one's word (a substring campaign on «برومبت» fires on «البرومبت»), the live one fires on
 * the new trigger's word (a live substring «سعر» fires on a new variant «السعر»), or they are the
 * same word. Whichever `bySpecificity` then ranks first answers both audiences, one of them with
 * the wrong DM. A word-mode trigger inside a longer word is not a collision: neither fires on the
 * other's comments. A campaign tied to one post is left out, because on that post it outranks
 * any campaign for every post, and elsewhere it never fires.
 *
 * The caller asks `matchCampaign` first whether a live campaign already answers the keyword; one
 * that does is reused, and nothing new is created to collide.
 */
export function triggerClashes<T extends CampaignMatchFields>(
    triggers: readonly string[], mode: KeywordMatchMode, campaigns: readonly T[]
): TriggerClash[] {
    const out: TriggerClash[] = [];
    for (const c of campaigns) {
        if (c.post_id || c.is_active === false) continue;
        const liveMode = normalizeMatchMode(c.match_mode);
        for (const live of c.trigger_keyword.split(/[,،]/).map((k) => k.trim()).filter(Boolean)) {
            const l = normalizeArabic(live);
            for (const trigger of triggers) {
                const t = normalizeArabic(trigger.trim());
                if (!t || !l) continue;
                if (t === l || keywordMatches(l, t, mode) || keywordMatches(t, l, liveMode)) out.push({ trigger, live });
            }
        }
    }
    return out;
}
