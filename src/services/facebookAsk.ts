/**
 * "Add keyword ask" for a Facebook video (Growth screen, an operator action — never automatic).
 *
 * The comment → keyword → DM automation only turns a viewer into a lead when the post tells the
 * viewer which word to comment. Older top videos may carry no such line. This appends one, with
 * wording from the Monteur's ask pool (`ASK_POOL`), for a keyword that a live campaign answers.
 *
 * Mechanism, chosen from Meta's reference: edit the post's text (`POST /{post-id}` with `message`,
 * pages_manage_posts; the Video node documents no update). If Meta refuses the edit as
 * unsupported (code 100 — Reels are not served by the Page-post edge), the same line goes up as a
 * Page comment instead (pages_manage_engagement). Both are idempotent: the live text or the
 * existing comments are read first, and an ask already there is a 409, not a second one.
 *
 * Campaigns have no platform column — one answers a comment on either platform — so "an active
 * campaign for Facebook" means `matchCampaign` fires on the keyword for this very post id, which
 * is what the webhook runs on a Facebook comment.
 */
import { queryOne, queryRows } from '../db/query.js';
import { normalizeArabic } from '../utils/arabic.js';
import { GrowthError } from './growth/common.js';
import { commentOnFacebookPost, getFacebookPostMessage, listFacebookPostCommentTexts, updateFacebookPostMessage } from './facebookEdit.js';
import { MetaApiError } from './instagram.js';
import { matchCampaign, type CampaignMatchFields } from './matching.js';
import { ASK_POOL } from './monteur/copy.js';
import { getTenant } from './tenant.js';

export type AskLanguage = 'ar' | 'en';
/** `live`: an ask a campaign answers · `dead`: an ask whose word no campaign answers · `none`. */
export type AskState = 'live' | 'dead' | 'none';

export type AskCampaign = CampaignMatchFields & { id?: string };

const ASK_VERBS = 'اكتب|اكتبوا|اكتبي|علّق|علق|علقوا|comment|type|drop|reply';
const QUOTED = /[«"“”]\s*([^«»"“”\n]{1,40}?)\s*[»"“”]/g;
const AFTER_VERB = new RegExp(`(?:${ASK_VERBS})\\s+(?:كلمة\\s+|the\\s+word\\s+|كلمه\\s+)?[«"“]?([^\\s«»"“”,.،:!؟?👇📩]+)`, 'gi');

/** Words a caption's ask line names: quoted ones on a line with an ask verb, and the word after the verb. */
export function askCandidates(caption: string): string[] {
    const out: string[] = [];
    for (const line of caption.split('\n')) {
        if (!new RegExp(ASK_VERBS, 'i').test(line)) continue;
        for (const m of line.matchAll(QUOTED)) out.push(m[1]!.trim());
        for (const m of line.matchAll(AFTER_VERB)) out.push(m[1]!.trim());
    }
    return [...new Set(out.filter(Boolean))];
}

/** Whether the caption asks for a comment, and whether a live campaign answers that word on this post. */
export function askState(caption: string, postId: string, campaigns: readonly AskCampaign[]): AskState {
    const words = askCandidates(caption);
    if (!words.length) return 'none';
    return words.some((w) => matchCampaign(w, postId, [...campaigns]) !== null) ? 'live' : 'dead';
}

/**
 * The keywords an operator may pick: every keyword of an active campaign that, typed alone as a
 * comment on this post, fires a campaign. Ones tied to this post first, then ones the caption
 * already speaks about, then the rest; each once.
 */
export function askKeywordOptions(postId: string, campaigns: readonly AskCampaign[], caption = ''): string[] {
    const active = campaigns.filter((c) => c.is_active !== false && (!c.post_id || c.post_id === postId));
    const captionNorm = normalizeArabic(caption);
    const seen = new Set<string>();
    const ranked: { kw: string; rank: number }[] = [];
    for (const c of active) {
        for (const raw of c.trigger_keyword.split(/[,،]/)) {
            const kw = raw.trim();
            const key = normalizeArabic(kw);
            if (!kw || !key || seen.has(key)) continue;
            if (matchCampaign(kw, postId, [...active]) === null) continue;
            seen.add(key);
            ranked.push({ kw, rank: c.post_id ? 0 : captionNorm.includes(key) ? 1 : 2 });
        }
    }
    return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.kw).slice(0, 200);
}

/** The ask's language: Arabic when the caption is mostly Arabic letters. */
export function askLanguage(caption: string): AskLanguage {
    const arabic = (caption.match(/[؀-ۿ]/g) ?? []).length;
    const latin = (caption.match(/[A-Za-z]/g) ?? []).length;
    return arabic >= latin ? 'ar' : 'en';
}

/** One ask line from the Monteur's pool, the keyword filled in. `variant` wraps around the pool. */
export function askText(keyword: string, language: AskLanguage, variant = 0): string {
    const pool = ASK_POOL[language];
    const i = ((Math.trunc(variant) % pool.length) + pool.length) % pool.length;
    return pool[i]!.split('{keyword}').join(keyword);
}

/** The post's text with the ask on its own paragraph at the end. */
export function withAsk(message: string, ask: string): string {
    const base = message.replace(/\s+$/, '');
    return base ? `${base}\n\n${ask}` : ask;
}

/** Whether this text already asks for the keyword (quoted the way the pool quotes it). */
export function mentionsAsk(text: string, keyword: string): boolean {
    return text.includes(`«${keyword}»`);
}

// ─── The operator action ─────────────────────────────────────────────────────────────────

interface PostRow { media_id: string; media_type: string | null; caption: string | null; permalink: string | null }
interface CampaignRow extends CampaignMatchFields { id: string }

const refuse = (status: number, code: string, message: string): GrowthError => new GrowthError(status, message, { code });

async function loadPost(creatorId: string, mediaId: unknown): Promise<PostRow> {
    if (typeof mediaId !== 'string' || !mediaId.trim()) throw refuse(400, 'bad_request', 'media_id is required.');
    const post = await queryOne<PostRow>(
        `SELECT media_id, media_type, caption, permalink FROM post_insights
          WHERE creator_id = $1 AND platform = 'facebook' AND media_id = $2`,
        [creatorId, mediaId.trim()]
    );
    if (!post) throw refuse(404, 'not_found', 'That Facebook post is not in the synced insights.');
    if (!/^(video|reels?)$/i.test(post.media_type ?? '')) {
        throw refuse(422, 'not_video', 'Only a Facebook video can get a keyword ask.');
    }
    return post;
}

export function loadActiveCampaigns(creatorId: string): Promise<CampaignRow[]> {
    return queryRows<CampaignRow>(
        `SELECT id, trigger_keyword, post_id, is_active, created_at, match_mode
           FROM campaigns WHERE creator_id = $1 AND is_active = true
          ORDER BY (post_id IS NOT NULL) DESC, length(trigger_keyword) DESC, created_at DESC`,
        [creatorId]
    );
}

export interface AskPreview {
    media_id: string;
    state: AskState;
    language: AskLanguage;
    /** Keywords a live campaign answers on this post. Empty means the action is refused. */
    keywords: string[];
    keyword: string | null;
    variant: number;
    variants: number;
    /** The exact line that would be appended. */
    text: string | null;
    /** How it goes out: the post's text is edited; Facebook refusing that falls back to a comment. */
    mechanism: 'edit';
}

/** What the operator will see before confirming. Read-only: nothing reaches Meta. */
export async function previewAsk(creatorId: string, input: { media_id?: unknown; keyword?: unknown; variant?: unknown }): Promise<AskPreview> {
    const post = await loadPost(creatorId, input.media_id);
    const campaigns = await loadActiveCampaigns(creatorId);
    const caption = post.caption ?? '';
    const keywords = askKeywordOptions(post.media_id, campaigns, caption);
    const language = askLanguage(caption);
    const variant = Number.isFinite(Number(input.variant)) ? Math.trunc(Number(input.variant)) : 0;
    const wanted = typeof input.keyword === 'string' ? input.keyword.trim() : '';
    const keyword = wanted && keywords.includes(wanted) ? wanted : keywords[0] ?? null;
    return {
        media_id: post.media_id,
        state: askState(caption, post.media_id, campaigns),
        language, keywords, keyword, variant,
        variants: ASK_POOL[language].length,
        text: keyword ? askText(keyword, language, variant) : null,
        mechanism: 'edit',
    };
}

export interface AskResult { mechanism: 'edit' | 'comment'; keyword: string; text: string }

/**
 * Appends the ask. The keyword must be one a live campaign answers on this post, re-derived here
 * (the client's list is a convenience, not an authority). Refuses when the post — read live from
 * Facebook — already carries a working ask or this keyword's line.
 */
export async function applyAsk(
    creatorId: string, input: { media_id?: unknown; keyword?: unknown; variant?: unknown }
): Promise<AskResult> {
    const post = await loadPost(creatorId, input.media_id);
    const campaigns = await loadActiveCampaigns(creatorId);
    const keywords = askKeywordOptions(post.media_id, campaigns, post.caption ?? '');
    if (!keywords.length) {
        throw refuse(409, 'no_campaign', 'No active campaign answers a comment on this post, so an ask would lead nowhere. Create or activate a campaign first.');
    }
    const keyword = typeof input.keyword === 'string' ? input.keyword.trim() : '';
    if (!keyword || !keywords.includes(keyword)) {
        throw refuse(422, 'keyword_not_live', 'That keyword is not answered by an active campaign on this post.');
    }

    const creator = await getTenant(creatorId, ['id', 'page_access_token']);
    const token = creator?.page_access_token;
    if (!token) throw refuse(409, 'no_token', 'No Meta access token is stored for this account.');

    const language = askLanguage(post.caption ?? '');
    const text = askText(keyword, language, Number(input.variant) || 0);

    let live: string;
    try {
        live = await getFacebookPostMessage(post.media_id, token);
    } catch (err) {
        throw metaRefusal(err);
    }
    // An empty read of a post that has a caption means Facebook did not hand the text over; editing
    // from it would replace the whole caption with the ask alone.
    if (!live.trim() && (post.caption ?? '').trim()) {
        throw refuse(502, 'text_unreadable', 'Facebook did not return this post\'s current text, so it was left unchanged.');
    }
    if (mentionsAsk(live, keyword) || askState(live, post.media_id, campaigns) === 'live') {
        throw refuse(409, 'already_asked', 'This post already asks viewers to comment a keyword.');
    }

    try {
        await updateFacebookPostMessage(post.media_id, withAsk(live, text), token);
        return { mechanism: 'edit', keyword, text };
    } catch (err) {
        // 100 = the edge does not take this object (a Reel). Anything else — a dead token,
        // a missing permission, a rate limit — is the operator's to see, not ours to route around.
        if (!(err instanceof MetaApiError) || err.metaCode !== 100) throw metaRefusal(err);
    }

    let existing: string[];
    try {
        existing = await listFacebookPostCommentTexts(post.media_id, token);
    } catch (err) {
        throw metaRefusal(err);
    }
    if (existing.some((c) => mentionsAsk(c, keyword))) {
        throw refuse(409, 'already_asked', 'A comment on this post already asks viewers to comment that keyword.');
    }
    try {
        await commentOnFacebookPost(post.media_id, text, token);
    } catch (err) {
        throw metaRefusal(err);
    }
    return { mechanism: 'comment', keyword, text };
}

function metaRefusal(err: unknown): GrowthError {
    if (err instanceof GrowthError) return err;
    const code = err instanceof MetaApiError ? err.metaCode : undefined;
    const message = err instanceof Error ? err.message : 'Facebook refused the request.';
    return refuse(code === 190 || code === 200 ? 409 : 502, code === 200 ? 'permission' : 'meta_failed', message);
}
