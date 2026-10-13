/**
 * What Instagram's answer means to the draft engine (docs/onboarding/03 §1, "Instagram"). Pure: the calls themselves
 * are in `igDiscovery.ts`; this is the field mapping, the failure classification and the step from a profile to the
 * sources a draft is made from.
 *
 * Two roads lead here and give the same `IgProfile`:
 *   - Business Discovery (`mapDiscoveryProfile`): the PLATFORM's own connected account reads a public Business or Creator
 *     account by username. The main source at creation, because a tenant exists before Meta is connected.
 *   - The tenant's own token (`mapOwnProfile`): once they have connected, for example on a re-draft.
 *
 * What is never kept: the profile picture (`profile_picture_url` is never requested, and a body that carries one has
 * it dropped here: the owner's rule on images) and any comment text (privacy: FAQ candidates come from the website
 * and the bio, not from what people wrote under a post).
 */
import type { SampleCandidate } from './draftSignals.js';
import type { DraftSource } from './fence.js';
import { MAX_CANDIDATES, pickSampleCandidates, type CaptionPost } from './captions.js';
import { sourceError, type SourceError, type SourceName, type SourceResult } from './sourceError.js';

/** How many posts a profile keeps: the 30 newest (03 §1). */
export const MAX_POSTS = MAX_CANDIDATES;

export interface IgPost extends CaptionPost {
    /** Graph media id. */
    mediaId: string;
    /** `''` when the post has none. */
    caption: string;
    timestamp: string | null;
    permalink: string | null;
    /** `null` when the creator hides it, or the type has none. */
    viewCount: number | null;
}

export interface IgProfile {
    via: 'business_discovery' | 'own_token';
    username: string;
    /** `null` when it was not asked for or Meta would not say (Business Discovery does not promise it: it is a separate request). */
    name: string | null;
    biography: string;
    website: string | null;
    followers: number | null;
    mediaCount: number | null;
    /** Newest first, at most `MAX_POSTS`. Each post's `id` is `p<n>`, its place in this list from 1: the id of its `ig_caption` source. */
    posts: IgPost[];
    /** The username the tenant typed is not the one Instagram answered with (case aside): the wizard asks "is this you?". */
    handleMismatch: boolean;
    /** Why the posts could not be read when the profile could (the bio is still a source); null otherwise. */
    postsError: SourceError | null;
}

// ─── Reading Meta's JSON ────────────────────────────────────────────────────────────────

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A finite number, or null. Meta sends some counts as strings. */
function count(value: unknown): number | null {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
    return Number.isFinite(n) ? n : null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => {
    const s = str(v).trim();
    return s ? s : null;
};

/** The same handle, by Instagram's rules (it is not case-sensitive). */
const sameHandle = (a: string, b: string): boolean => a.trim().toLowerCase().replace(/^@/, '') === b.trim().toLowerCase().replace(/^@/, '');

/** One media object as a post. `index` is its place in the list (from 0), which is what its source id is made from. */
function mapPost(raw: unknown, index: number): IgPost | null {
    if (!isObj(raw)) return null;
    const mediaId = str(raw.id) || (count(raw.id) !== null ? String(raw.id) : '');
    return {
        id: `p${index + 1}`,
        mediaId,
        caption: str(raw.caption),
        mediaType: strOrNull(raw.media_type),
        productType: strOrNull(raw.media_product_type),
        timestamp: strOrNull(raw.timestamp),
        permalink: strOrNull(raw.permalink),
        likeCount: count(raw.like_count),
        commentsCount: count(raw.comments_count),
        viewCount: count(raw.view_count),
    };
}

/** The `data` of a media edge (`{ data: [...] }`), newest first, as posts: at most `MAX_POSTS`, an item that is not an object skipped. */
function mapPosts(edge: unknown): IgPost[] {
    const data = isObj(edge) && Array.isArray(edge.data) ? edge.data : [];
    const posts: IgPost[] = [];
    for (const raw of data) {
        const post = mapPost(raw, posts.length);
        if (post) posts.push(post);
        if (posts.length >= MAX_POSTS) break;
    }
    return posts;
}

/**
 * A Business Discovery answer (`{ business_discovery: {…}, id }`) as a profile. Meta answers an account it will not show
 * (age-restricted, for one) with 200 and no `business_discovery`, which is `age_gated`: the account is not wrong, it is
 * closed to this kind of read. `nameBody` is the answer of the separate request for `name` (it is not a field Business
 * Discovery promises, so it is never in the main one); when it is missing or empty, `name` is null.
 */
export function mapDiscoveryProfile(typedHandle: string, body: unknown, nameBody?: unknown): SourceResult<IgProfile> {
    const bd = isObj(body) ? body.business_discovery : undefined;
    if (!isObj(bd)) {
        return {
            ok: false,
            error: sourceError('instagram_discovery', 'age_gated', 'Instagram returned no profile for this account (an age-restricted or restricted account does this).'),
        };
    }
    const username = strOrNull(bd.username) ?? typedHandle;
    const named = isObj(nameBody) && isObj(nameBody.business_discovery) ? strOrNull(nameBody.business_discovery.name) : null;
    return {
        ok: true,
        value: {
            via: 'business_discovery',
            username,
            name: named,
            biography: str(bd.biography),
            website: strOrNull(bd.website),
            followers: count(bd.followers_count),
            mediaCount: count(bd.media_count),
            posts: mapPosts(bd.media),
            handleMismatch: !sameHandle(username, typedHandle),
            postsError: null,
        },
    };
}

/**
 * The tenant's own account, from the two batch answers: the user node (`username,name,biography,website,followers_count,
 * media_count`) and `/media` (up to 50 posts; the 30 newest are kept). `typedHandle` is what they typed in the wizard, or
 * null when nothing was.
 */
export function mapOwnProfile(typedHandle: string | null, userBody: unknown, mediaBody: unknown): SourceResult<IgProfile> {
    if (!isObj(userBody) || !strOrNull(userBody.username)) {
        return {
            ok: false,
            error: sourceError('instagram_own', 'bad_response', 'Instagram answered for the connected account without a username.'),
        };
    }
    const username = str(userBody.username).trim();
    return {
        ok: true,
        value: {
            via: 'own_token',
            username,
            name: strOrNull(userBody.name),
            biography: str(userBody.biography),
            website: strOrNull(userBody.website),
            followers: count(userBody.followers_count),
            mediaCount: count(userBody.media_count),
            posts: mapPosts(mediaBody),
            handleMismatch: typedHandle !== null && !sameHandle(username, typedHandle),
            postsError: null,
        },
    };
}

// ─── Failures ───────────────────────────────────────────────────────────────────────────

/** A failed Graph call as `GraphSession` reports it (`growth/graph.ts`), written out here so this module imports nothing that talks to Meta. */
export interface GraphFailureLike {
    code: number | null;
    subcode: number | null;
    message: string;
    status: number | null;
}

/** Meta's throttling codes: app, user, Pages, custom, Pages BUC, Instagram BUC. */
const THROTTLE_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613, 80001, 80002]);
/** "This token may not read this": 10 (permission denied), 3 (no capability), and the 200s (a specific permission is missing). */
const isPermissionCode = (code: number): boolean => code === 10 || code === 3 || (code >= 200 && code < 300);
/** Meta's own "try again" codes: 1 (unknown) and 2 (service temporarily unavailable). */
const TRANSIENT_CODES: ReadonlySet<number> = new Set([1, 2]);

/** The words Meta uses for an account Business Discovery cannot find. Code 110 is the usual; the sentence is the fallback. */
const CANNOT_FIND = /\b(?:cannot find (?:the )?user|invalid user(?: id)?|user not found|no user found)\b/i;

export interface ClassifyOptions {
    /** The session was throttled while this call ran (a usage header past the ceiling, or a throttling code on another item). */
    throttled?: boolean;
    /** The credentials the call used, removed from the message. */
    secrets?: readonly (string | null | undefined)[];
}

/**
 * A failed Instagram read, as a source error (03 §1, "Failures"). `source` says which road it was: only Business Discovery
 * has the "cannot find user" answer, which Meta gives for an account that does not exist, one that is private and a personal
 * one alike, so the wizard says all three at once (`not_readable`).
 */
export function classifyGraphFailure(source: Extract<SourceName, 'instagram_discovery' | 'instagram_own'>, failure: GraphFailureLike, opts: ClassifyOptions = {}): SourceError {
    const { code, subcode, status } = failure;
    const init = { code, http_status: status, secrets: opts.secrets };
    const make = (kind: Parameters<typeof sourceError>[1], message: string): SourceError => sourceError(source, kind, message, init);
    const said = failure.message || 'Instagram request failed';

    if ((code !== null && THROTTLE_CODES.has(code)) || status === 429 || opts.throttled) {
        return make('rate_limited', `Instagram is limiting how many lookups the platform may make right now: ${said}`);
    }
    if (source === 'instagram_discovery' && (code === 110 || CANNOT_FIND.test(said))) {
        return make('not_readable', 'Not found, or not a Business or Creator account, or private (Business Discovery reads only public professional accounts).');
    }
    // The token itself, or the account it asks as: dead, or without the permission. (Code 100 with subcode 33 is "that object
    // cannot be loaded or accessed": for Business Discovery the object is OUR account, since the target is named in the field.)
    if (code === 190 || (code !== null && isPermissionCode(code)) || (code === 100 && subcode === 33)) {
        return make('no_access', `The Instagram connection used for this read cannot do it: ${said}`);
    }
    if (code !== null && TRANSIENT_CODES.has(code)) return make('upstream', `Instagram had a temporary problem: ${said}`);
    if (status !== null && status >= 500) return make('upstream', `Instagram failed (HTTP ${status}): ${said}`);
    if (status !== null && status >= 400) return make('bad_request', `Instagram refused the request: ${said}`);
    if (code !== null) return make('bad_request', `Instagram refused the request: ${said}`);
    // No code and no status: the call never produced an answer (a timeout, a reset, a batch item Meta timed out).
    return make('upstream', `Instagram did not answer: ${said}`);
}

// ─── From a profile to the draft's sources ──────────────────────────────────────────────

export interface InstagramDraftSources {
    sources: DraftSource[];
    /** The sample pool (03 §3.3): ids of `ig_caption` sources above. */
    candidates: SampleCandidate[];
    followers: number | null;
    mediaCount: number | null;
}

/**
 * The sources an Instagram profile gives a draft: one `ig_bio` (the name, the bio and the website link on a line each,
 * so a URL the model cites is one a source holds) and one `ig_caption` per post with a caption, `p<n>` by its place among
 * the posts. Every caption is a source, short ones too: `registerSignals` reads them all, and only the sample pool is
 * filtered (`pickSampleCandidates`). They are not cleaned here: `prepareSources` does that for the whole list.
 */
export function instagramSources(profile: IgProfile): InstagramDraftSources {
    const sources: DraftSource[] = [];
    const bio = [profile.name, profile.biography.trim(), profile.website].filter((line): line is string => Boolean(line && line.trim()));
    if (bio.length > 0) sources.push({ id: 'bio', kind: 'ig_bio', text: bio.join('\n') });
    for (const post of profile.posts) {
        if (post.caption.trim()) sources.push({ id: post.id, kind: 'ig_caption', text: post.caption });
    }
    return { sources, candidates: pickSampleCandidates(profile.posts), followers: profile.followers, mediaCount: profile.mediaCount };
}
