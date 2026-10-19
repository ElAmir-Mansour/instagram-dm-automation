/**
 * "Try a comment": a dry run of the comment pipeline's matching step.
 *
 * `POST /api/campaigns/try` answers "what would my campaigns do with this comment?" without
 * sending, claiming or recording anything. It reads the tenant's live campaigns through the same
 * query the webhook uses (`liveCampaigns.ts`) and decides with the same rule (`matching.ts`:
 * `rankMatches` and `judgeCampaign` are what `matchCampaign` itself is built from). It owns no
 * matching logic, only the request's shape and the sentence-sized answers around the rule.
 *
 * It never writes. Its only statements are two SELECTs (the live list, and the stored
 * `created_at` of a campaign being edited), and `matching.try.test.ts` fails if that changes.
 *
 * A `draft` is the campaign as the editor holds it. It replaces the stored campaign with the
 * same id, or is added when it has none, so the answer is "what happens if I save this".
 */
import { queryOne } from '../db/query.js';
import { isKeywordMatchMode, normalizeArabic, normalizeMatchMode, type KeywordMatchMode } from '../utils/arabic.js';
import { loadLiveCampaigns } from './liveCampaigns.js';
import {
    judgeCampaign, rankMatches, triggerKeywords, winReason,
    type CampaignMatchFields, type MissReason, type WinReason,
} from './matching.js';

export const MAX_TRY_COMMENT_LENGTH = 2000;
/** The longest keyword list a draft may carry: bounds the work one request can ask of the matcher. */
export const MAX_TRY_KEYWORDS_LENGTH = 1000;
export const MAX_TRY_POST_IDS = 50;
const MAX_POST_ID_LENGTH = 100;

/** What `winner.id` says when the campaign that answers is the draft. */
export const DRAFT_ID = 'draft';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORMS = ['instagram', 'facebook'] as const;

// ─── Request ────────────────────────────────────────────────────────────────────────────

export interface TryDraft {
    /** The stored campaign this draft edits, or null for one not saved yet. */
    id: string | null;
    trigger_keyword: string;
    match_mode: KeywordMatchMode;
    post_id: string | null;
    /** Several posts for one campaign. Empty means "use `post_id`". */
    post_ids: string[];
    /** False when the draft will be saved paused: it then matches nothing. */
    is_active: boolean;
}

export interface TryRequest {
    comment: string;
    /** Matching is the same on both platforms; accepted so a client can say which it is trying. */
    platform: 'instagram' | 'facebook' | null;
    /** The post the comment is on; '' when none was named, which only generic campaigns match. */
    postId: string;
    draft: TryDraft | null;
}

export type ParsedTry = { ok: true; value: TryRequest } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function postIdField(value: unknown, name: string): { ok: true; value: string | null } | { ok: false; error: string } {
    if (value === undefined || value === null || value === '') return { ok: true, value: null };
    if (typeof value !== 'string' || value.length > MAX_POST_ID_LENGTH) {
        return { ok: false, error: `${name} must be a string of at most ${MAX_POST_ID_LENGTH} characters.` };
    }
    return { ok: true, value };
}

function parseDraft(raw: unknown): { ok: true; value: TryDraft } | { ok: false; error: string } {
    if (!isRecord(raw)) return { ok: false, error: 'draft must be an object.' };

    const id = raw.id ?? null;
    if (id !== null && (typeof id !== 'string' || !UUID_PATTERN.test(id))) {
        return { ok: false, error: 'draft.id must be a campaign id or null.' };
    }

    if (typeof raw.trigger_keyword !== 'string') {
        return { ok: false, error: 'draft.trigger_keyword must be a string.' };
    }
    if (raw.trigger_keyword.length > MAX_TRY_KEYWORDS_LENGTH) {
        return { ok: false, error: `draft.trigger_keyword must be at most ${MAX_TRY_KEYWORDS_LENGTH} characters.` };
    }

    // Rejected rather than coerced, as on create/update: a draft tried in a mode that was
    // silently swapped for another would report on a campaign the owner is not saving.
    const rawMode = raw.match_mode ?? 'substring';
    if (!isKeywordMatchMode(rawMode)) {
        return { ok: false, error: 'draft.match_mode must be one of: substring, word.' };
    }

    const postId = postIdField(raw.post_id, 'draft.post_id');
    if (!postId.ok) return postId;

    let postIds: string[] = [];
    if (raw.post_ids !== undefined && raw.post_ids !== null) {
        if (!Array.isArray(raw.post_ids) || raw.post_ids.length > MAX_TRY_POST_IDS) {
            return { ok: false, error: `draft.post_ids must be a list of at most ${MAX_TRY_POST_IDS} post ids.` };
        }
        for (const entry of raw.post_ids) {
            const one = postIdField(entry, 'draft.post_ids[]');
            if (!one.ok) return one;
            if (one.value) postIds.push(one.value);
        }
        postIds = [...new Set(postIds)];
    }

    if (raw.is_active !== undefined && raw.is_active !== null && typeof raw.is_active !== 'boolean') {
        return { ok: false, error: 'draft.is_active must be true or false.' };
    }

    return {
        ok: true,
        value: {
            id,
            trigger_keyword: raw.trigger_keyword,
            match_mode: rawMode,
            post_id: postId.value,
            post_ids: postIds,
            is_active: raw.is_active !== false,
        },
    };
}

export function parseTryRequest(body: unknown): ParsedTry {
    if (!isRecord(body)) return { ok: false, error: 'comment is required.' };

    const { comment } = body;
    if (typeof comment !== 'string' || !comment.trim()) return { ok: false, error: 'comment is required.' };
    if (comment.length > MAX_TRY_COMMENT_LENGTH) {
        return { ok: false, error: `comment must be at most ${MAX_TRY_COMMENT_LENGTH} characters.` };
    }

    let platform: TryRequest['platform'] = null;
    if (body.platform !== undefined && body.platform !== null) {
        if (!(PLATFORMS as readonly unknown[]).includes(body.platform)) {
            return { ok: false, error: `platform must be one of: ${PLATFORMS.join(', ')}.` };
        }
        platform = body.platform as TryRequest['platform'];
    }

    const postId = postIdField(body.postId, 'postId');
    if (!postId.ok) return postId;

    let draft: TryDraft | null = null;
    if (body.draft !== undefined && body.draft !== null) {
        const parsed = parseDraft(body.draft);
        if (!parsed.ok) return parsed;
        draft = parsed.value;
    }

    return { ok: true, value: { comment, platform, postId: postId.value ?? '', draft } };
}

// ─── Answer ─────────────────────────────────────────────────────────────────────────────

/** Why the winner won: the ranking's deciding tier, or `only_match` when nothing else fired. */
export type TryWinReason = WinReason | 'only_match';

/** Why the draft does not answer: it did not fire, or another campaign outranks it. */
export type DraftMissReason = MissReason | 'shadowed';

export interface TryWinner {
    /** The campaign's id, or `'draft'` when the draft answers. */
    id: string;
    /** Its keyword list, as typed. */
    keywords: string[];
    /** The keyword of that list that fired, as typed. */
    matched: string;
    matchMode: KeywordMatchMode;
    reason: TryWinReason;
}

export interface NearMiss {
    /** The campaign's id, or `'draft'`. */
    id: string;
    /** The keyword that sits inside a longer word of the comment. */
    keyword: string;
    why: 'word_mode';
}

export interface TryResult {
    /** The comment as matching sees it. */
    normalized: string;
    /** The campaign the webhook would answer this comment with, or null when none would. */
    winner: TryWinner | null;
    /**
     * True when the draft is the campaign that answers. A draft that fires but is outranked is
     * false, with `draftMissReason: 'shadowed'` and the campaign that answers in `winner`.
     */
    draftMatches: boolean;
    /** Present only when a draft was sent and it does not answer. */
    draftMissReason?: DraftMissReason;
    /**
     * Live campaigns, and the draft, that did not fire only because their word mode needs the
     * keyword to stand alone, and it sits inside a longer word of the comment.
     */
    nearMisses: NearMiss[];
}

/** A stored campaign as the dry run needs it: the columns matching reads, and an id. */
export type StoredCampaign = CampaignMatchFields & { id: string };

/**
 * A draft's post, in the single-post shape matching knows. With several posts, the one the
 * comment is on when it is among them, else the first (which cannot match this comment).
 *
 * TODO(R-05): when `campaigns.post_ids` exists and `matching.ts` reads it, this goes away and the
 * draft is judged by the stored shape like every other campaign.
 */
function draftPostId(draft: TryDraft, postId: string): string | null {
    const ids = draft.post_ids.length ? draft.post_ids : draft.post_id ? [draft.post_id] : [];
    if (!ids.length) return null;
    return ids.includes(postId) ? postId : ids[0]!;
}

/** Pure: the answer for a request, given the stored campaigns and the editing draft's `created_at`. */
export function evaluateTry(
    req: TryRequest,
    stored: readonly StoredCampaign[],
    draftCreatedAt: Date | string | null = null,
    now: Date = new Date()
): TryResult {
    const { postId, draft } = req;

    const candidates: StoredCampaign[] = stored.filter((c) => !(draft?.id && c.id === draft.id));
    let draftCandidate: StoredCampaign | null = null;
    if (draft) {
        draftCandidate = {
            id: DRAFT_ID,
            trigger_keyword: draft.trigger_keyword,
            match_mode: draft.match_mode,
            post_id: draftPostId(draft, postId),
            is_active: draft.is_active,
            // A campaign being edited keeps its place in the ranking; a new one is the newest.
            created_at: draftCreatedAt ?? now,
        };
        candidates.push(draftCandidate);
    }

    const normalized = normalizeArabic(req.comment);
    const ranked = rankMatches(req.comment, postId, candidates);
    const top = ranked[0];

    const winner: TryWinner | null = top
        ? {
            id: top.campaign.id,
            keywords: triggerKeywords(top.campaign.trigger_keyword).map((k) => k.typed),
            matched: top.matched.typed,
            matchMode: normalizeMatchMode(top.campaign.match_mode),
            reason: ranked.length === 1 ? 'only_match' : winReason(top.campaign, ranked[1]!.campaign),
        }
        : null;

    const result: TryResult = {
        normalized,
        winner,
        draftMatches: winner?.id === DRAFT_ID,
        nearMisses: [],
    };

    if (draftCandidate && !result.draftMatches) {
        const verdict = judgeCampaign(normalized, postId, draftCandidate);
        result.draftMissReason = verdict.fires ? 'shadowed' : verdict.miss!;
    }

    // A near miss is only worth showing for a campaign that would otherwise answer here: live,
    // and for this post. A word-mode campaign for another post is not "nearly" anything.
    for (const c of candidates) {
        if (c.is_active === false || (c.post_id && c.post_id !== postId)) continue;
        const verdict = judgeCampaign(normalized, postId, c);
        if (verdict.miss === 'word_mode' && verdict.nearMiss) {
            result.nearMisses.push({ id: c.id, keyword: verdict.nearMiss.typed, why: 'word_mode' });
        }
    }

    return result;
}

/** The dry run: reads, decides, answers. Writes nothing. */
export async function tryComment(creatorId: string, req: TryRequest): Promise<TryResult> {
    const stored = await loadLiveCampaigns(creatorId);

    let draftCreatedAt: Date | string | null = null;
    const editing = req.draft?.id ?? null;
    if (editing) {
        const live = stored.find((c) => c.id === editing);
        // A paused campaign is not in the live list but keeps its age when it is switched on.
        draftCreatedAt = live
            ? live.created_at
            : (await queryOne<{ created_at: Date }>(
                'SELECT created_at FROM campaigns WHERE id = $1 AND creator_id = $2', [editing, creatorId]
            ))?.created_at ?? null;
    }

    return evaluateTry(req, stored, draftCreatedAt);
}
