/**
 * What Muse is shown for one thing a customer sent (docs/specs/005-muse-sees research R18, the live facts of 2026-10-30): the decision between a download, the
 * library's notes, and a caption, made from what Instagram's event actually holds.
 *
 *   resolveSource(ref, ctx)   → a picture or a video to show the model (`media`), or a finished perception that needs no model (`ready`), or why there is nothing (`nothing`).
 *
 * **What a shared reel or post is** (`MediaRef`, media.ts): a shared REEL (`ig_reel`) carries `reel_video_id`, and its `url` is a web page that is NEVER downloaded; a
 * shared POST (`ig_post`) carries `ig_post_media_id` and a `url` that serves its JPEG cover, not the video. Both ids can be asked the Graph API for, with the Page
 * token: `GET /{id}?fields=media_type,media_url,owner,permalink,caption`. For the creator's OWN reel that says `VIDEO`, names the creator as the owner and gives a
 * fresh `*.fbcdn.net` mp4. For anyone else's it fails (a permission error: the node is not ours) or names another owner.
 *
 *   1. **The creator's own reel or post**, in this order:
 *        - the library (`reel_analyses`, the owner's reels each watched once) has a row for that media id: its notes ARE the perception, and no model is called.
 *          A row exists only for the creator's own media, so a hit needs no Graph call at all.
 *        - else the Graph lookup says the owner is this account and the media is a VIDEO: its mp4 is downloaded (at most 35 MB) and Muse WATCHES it.
 *   2. **Anyone else's**, or one that cannot be told:
 *        - a shared post: its COVER (the `url`'s JPEG) and its caption: "saw the cover and caption".
 *        - a shared reel: only its caption (`title`), as text and with no model: "read the caption". There is no cover to show, because the `url` is a page.
 *   3. **A photo, a video, a story, a story mention, the story a reply answers**: the `url` Meta sent, downloaded and shown. What the bytes are is decided by the
 *      response, never by the attachment's type (`fetchMedia`).
 *
 * **Honest about what was seen.** Each way of looking is named (`HowSeen`), and the description it produces is prefixed with it (`withHow`): "Watched the reel.",
 * "Saw the cover and caption.", "Read the caption.". A reel read by its caption alone is never said to have been watched, and a post whose video was not shown is never
 * claimed to have been. Whose it is (`Owner`) is decided here from the Graph's owner, never left to the model: a reel that cannot be shown to be the account's own is
 * never called the account's own.
 *
 * Nothing here is logged with a link or an id of Meta's (a link is a signed URL); the caller logs the result. Nothing throws for what the network or the Graph API can do.
 */
import { graphFailure, GraphSession } from '../growth/graph.js';
import type { FetchLike } from '../llm/types.js';
import {
    CONNECT_TIMEOUT_MS, fetchMedia, TOTAL_TIMEOUT_MS, type DownloadedMedia, type MediaRef, type MediaResult,
} from './media.js';
import { HOW_PREFIX, withHow, type HowSeen } from './how.js';
import { readReelAnalysis, type ReelAnalysis } from './store.js';
import { oneLine, SEEN_MAX_CHARS, SPEECH_MAX_CHARS } from './text.js';
import type { AboutOwner, FailReason, Perception } from './types.js';

export { HOW_PREFIX, withHow, type HowSeen };

/** Whose the media is, as far as the code can tell: the Graph API's owner, never the model's guess. */
export type Owner = 'own' | 'other' | 'unknown';

export type Draft = Omit<Perception, 'stored_at'>;

export type Source =
    /** Show this to the model. `caption` is what came with it, if anything. */
    | { source: 'media'; how: HowSeen; media: DownloadedMedia; caption: string | null; owner: Owner }
    /** Already understood, with no model: the library's notes, or a caption. */
    | { source: 'ready'; how: 'library' | 'caption'; perception: Draft }
    /** Nothing to show. `skipped`: the event carried nothing to open. `failed`: it was asked for and did not come. */
    | { source: 'nothing'; status: 'skipped'; reason: 'no_url' }
    | { source: 'nothing'; status: 'failed'; reason: Extract<FailReason, 'too_large' | 'fetch_failed' | 'expired_url' | 'timeout'> };

// ─── The Graph lookup ────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the Graph API says of one media node. Every field may be missing: a node of someone else's has none of them. */
export interface GraphMedia {
    ownerId: string | null;
    mediaType: string | null;
    mediaUrl: string | null;
    caption: string | null;
}

/**
 * `notOurs`: Meta answered that this node cannot be read with the Page's token (a permission error, or no such object for it): it is not the account's own, or not
 * any more. A failure that is not that (a throttle, a 5xx, a timeout) leaves ownership unknown.
 */
export type Lookup = { ok: true; media: GraphMedia } | { ok: false; notOurs: boolean };

const GRAPH_FIELDS = 'media_type,media_url,owner,permalink,caption';
/**
 * Meta's codes for "this token may not read it" (10, 200) and "no such object, or an unsupported request" (100, 803). A failure that names a code is judged by the code
 * (a 400 with code 190 is a dead token, not somebody else's reel); only one with no code is judged by its HTTP status.
 */
const NOT_OURS_CODES: ReadonlySet<number> = new Set([10, 100, 200, 803]);
const NOT_OURS_STATUSES: ReadonlySet<number> = new Set([403, 404]);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** `GET /{id}` of a media node with the Page token. Never throws. */
export async function lookupMedia(token: string, id: string): Promise<Lookup> {
    try {
        const body: any = await new GraphSession(token).get(id, { fields: GRAPH_FIELDS });
        const owner = body?.owner;
        return {
            ok: true,
            media: {
                ownerId: str(owner) ?? str(owner?.id),
                mediaType: str(body?.media_type),
                mediaUrl: str(body?.media_url),
                caption: str(body?.caption),
            },
        };
    } catch (err) {
        const failure = graphFailure(err);
        const notOurs = failure.code !== null ? NOT_OURS_CODES.has(failure.code) : failure.status !== null && NOT_OURS_STATUSES.has(failure.status);
        return { ok: false, notOurs };
    }
}

// ─── The library's notes ─────────────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => oneLine(x, 80)).filter(Boolean).slice(0, max) : []);

/**
 * The library's analysis of a reel as the perception of a shared one, or null when it holds no summary to say. The summary, the topics and what is on screen make
 * the description; the narration is the speech. It is the account's own content by construction (the library holds only the creator's reels) and costs nothing now.
 * It has NO confidence: that number is a model's own about one answer, and these notes were not asked a question. Pure.
 */
export function libraryPerception(kind: Draft['kind'], analysis: ReelAnalysis): Draft | null {
    if (!isObj(analysis.result)) return null;
    const summary = oneLine(analysis.result['summary'], 400);
    if (!summary) return null;
    const topics = strings(analysis.result['topics'], 6);
    const onScreen = strings(analysis.result['seen_on_screen'], 4);
    const seen = [summary, topics.length ? `Topics: ${topics.join(', ')}.` : '', onScreen.length ? `On screen: ${onScreen.join('; ')}.` : ''].filter(Boolean).join(' ');
    const narration = oneLine(analysis.result['narration'], SPEECH_MAX_CHARS);
    return {
        v: 1,
        kind,
        status: 'ok',
        seen: oneLine(`${HOW_PREFIX.library} ${seen}`, SEEN_MAX_CHARS),
        ...(narration ? { transcript: narration } : {}),
        about_owner: 'own_content',
        model: analysis.model?.trim() || 'library',
        ms: 0,
        usd: 0,
    };
}

/** A caption read on its own, as the perception of a reel nobody could be shown: the caption verbatim in the description, no model, no cost, no confidence. Pure. */
export function captionPerception(kind: Draft['kind'], caption: string, owner: Owner): Draft {
    return {
        v: 1,
        kind,
        status: 'ok',
        seen: oneLine(`${HOW_PREFIX.caption} It says: «${oneLine(caption, 450)}»`, SEEN_MAX_CHARS),
        about_owner: ownerAbout(owner) ?? 'unclear',
        model: 'caption',
        ms: 0,
        usd: 0,
    };
}

// ─── Whose it is ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the code knows of whose it is, as the field the sales turn reads; null for "cannot tell", which leaves the model's own say. */
export function ownerAbout(owner: Owner): AboutOwner | null {
    return owner === 'own' ? 'own_content' : owner === 'other' ? 'other_content' : null;
}

// ─── The decision ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SourceContext {
    creatorId: string;
    /** The creator's own Instagram account id: a media node is the account's own when the Graph API names this id as its owner. */
    igAccountId: string | null;
    /** The Page token, for the Graph API only: it never goes with a media download. */
    pageToken: string;
    /** When the whole perception step must be over (epoch ms): no download is started that could not finish. */
    deadlineAt: number;
}

export interface SourceDeps {
    now?: () => number;
    library?: (creatorId: string, igMediaId: string) => Promise<ReelAnalysis | null>;
    lookup?: (token: string, id: string) => Promise<Lookup>;
    download?: (link: string | null | undefined, options: { kind: MediaRef['kind']; connectMs: number; totalMs: number }) => Promise<MediaResult>;
}

let mediaFetch: FetchLike | undefined;

/** Tests only: the `fetch` every media download made through this module uses. Returns the previous one. */
export function setMediaFetch(next: FetchLike | undefined): FetchLike | undefined {
    const previous = mediaFetch;
    mediaFetch = next;
    return previous;
}

const liveDownload: NonNullable<SourceDeps['download']> = (link, options) => fetchMedia(link, { kind: options.kind, connectMs: options.connectMs, totalMs: options.totalMs, ...(mediaFetch ? { fetchImpl: mediaFetch } : {}) });

/** A library read that fails is no library: the reel is then watched instead. */
const liveLibrary: NonNullable<SourceDeps['library']> = async (creatorId, id) => {
    try {
        return await readReelAnalysis(creatorId, id);
    } catch {
        return null;
    }
};

export async function resolveSource(ref: MediaRef, ctx: SourceContext, deps: SourceDeps = {}): Promise<Source> {
    const now = deps.now ?? Date.now;
    const library = deps.library ?? liveLibrary;
    const lookup = deps.lookup ?? lookupMedia;
    const download = deps.download ?? liveDownload;

    /** One download, cut to what is left of the step. */
    const fetchWithin = async (link: string | null): Promise<MediaResult> => {
        const left = ctx.deadlineAt - now();
        if (left <= 0) return { ok: false, status: 'failed', reason: 'timeout' };
        return download(link, { kind: ref.kind, connectMs: Math.min(CONNECT_TIMEOUT_MS, left), totalMs: Math.min(TOTAL_TIMEOUT_MS, left) });
    };
    /** A download that is not a picture or a video is not one: an audio file here is nothing to show. */
    const shown = (result: MediaResult): result is Extract<MediaResult, { ok: true }> => result.ok && result.media.mediaKind !== 'audio';
    const failureOf = (result: MediaResult): Source => {
        if (result.ok) return { source: 'nothing', status: 'failed', reason: 'fetch_failed' };
        return result.status === 'skipped' ? { source: 'nothing', status: 'skipped', reason: 'no_url' } : { source: 'nothing', status: 'failed', reason: result.reason };
    };

    // ─ A shared reel or post: the library, the Graph API, a cover, a caption ─
    if (ref.kind === 'reel' || ref.kind === 'share') {
        const id = ref.reelVideoId ?? ref.igPostMediaId;
        let owner: Owner = 'unknown';
        let graphCaption: string | null = null;
        let failed: Source | null = null;

        if (id) {
            const notes = await library(ctx.creatorId, id);
            const known = notes ? libraryPerception(ref.kind, notes) : null;
            if (known) return { source: 'ready', how: 'library', perception: known };

            const found = await lookup(ctx.pageToken, id);
            if (found.ok) {
                owner = ctx.igAccountId !== null && found.media.ownerId === ctx.igAccountId ? 'own' : 'other';
                if (owner === 'own') graphCaption = found.media.caption;
                if (owner === 'own' && found.media.mediaType === 'VIDEO' && found.media.mediaUrl) {
                    const video = await fetchWithin(found.media.mediaUrl);
                    if (shown(video)) return { source: 'media', how: video.media.mediaKind === 'video' ? 'watched' : 'cover', media: video.media, caption: ref.title ?? graphCaption, owner };
                    // A reel has no cover to fall back on (its `url` is a page); a post has one.
                    failed = failureOf(video);
                    if (ref.kind === 'reel') return failed;
                }
            } else if (found.notOurs) {
                owner = 'other';
            }
        }

        if (ref.kind === 'share' && ref.url) {
            const cover = await fetchWithin(ref.url);
            if (shown(cover)) return { source: 'media', how: cover.media.mediaKind === 'video' ? 'watched' : 'cover', media: cover.media, caption: ref.title ?? graphCaption, owner };
            failed = failed ?? failureOf(cover);
        }

        const caption = ref.title ?? graphCaption;
        if (caption) return { source: 'ready', how: 'caption', perception: captionPerception(ref.kind, caption, owner) };
        return failed ?? { source: 'nothing', status: 'skipped', reason: 'no_url' };
    }

    // ─ Everything else: the link Meta sent ─
    const got = await fetchWithin(ref.url);
    if (!shown(got)) return failureOf(got);
    // The story a reply answers is the account's own; a story that mentions the account is the customer's. A photo or a video they sent, or a story they shared, cannot be told.
    const owner: Owner = ref.kind === 'story_reply' ? 'own' : ref.kind === 'story_mention' ? 'other' : 'unknown';
    return { source: 'media', how: 'media', media: got.media, caption: null, owner };
}
