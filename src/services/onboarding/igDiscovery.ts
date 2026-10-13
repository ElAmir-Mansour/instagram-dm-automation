/**
 * Reading a creator's Instagram for the draft (docs/onboarding/03 §1). The two roads, both through `GraphSession`
 * (`growth/graph.ts`): `metaHttp`'s 10 s timeout, `withRetry`, the token in the Authorization header and never in a URL,
 * and the rate-limit headroom Meta reports as it goes. Not pure: it talks to Meta. The mapping, the failure
 * classification and the step to sources are in `igMap.ts`.
 *
 *   - `fetchBusinessDiscovery`: the PLATFORM's own connected account reads a public Business or Creator account by
 *     username, `GET /{our-ig-id}?fields=business_discovery.username(h){…}`. The main source at creation, because a
 *     tenant exists before Meta is connected. It needs `instagram_basic`, `instagram_manage_insights` and
 *     `pages_read_engagement`, and shares the account's rate limit with the Growth competitor checks.
 *   - `fetchOwnInstagram`: the tenant's own token, once they have connected (a re-draft). One batch: the user node and `/media`.
 *
 * Neither throws for a platform that says no: the answer is a `SourceResult` whose error carries a kind and whether
 * trying again can help. An error never carries the token: the axios error (which holds the request, so the
 * Authorization header) is reduced to Meta's code, subcode, status and message, and the message is scrubbed.
 */
import { describeError, log } from '../../utils/log.js';
import { GraphSession, graphFailure, type BatchOutcome, type GraphFailure } from '../growth/graph.js';
import { classifyGraphFailure, mapDiscoveryProfile, mapOwnProfile, MAX_POSTS, type IgProfile } from './igMap.js';
import { normalizeInstagramHandle } from './handles.js';
import { scrubSecrets, sourceFail, type SourceResult } from './sourceError.js';

export interface GraphCredentials {
    /** A Page access token. Never logged, never in a URL, never in an error. */
    token: string;
    /** The Instagram user id (`instagram_page_id`), numeric. */
    igUserId: string;
}

/** An Instagram user id is a number; it is spliced into a path, so nothing else is let through. */
const IG_USER_ID = /^\d{1,25}$/;

/** The media fields asked of Business Discovery and of the tenant's own account alike (03 §1). `view_count` is absent when hidden. */
const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count';
export const DISCOVERY_MEDIA_LIMIT = MAX_POSTS;
/** The own-token request takes 50 and keeps the 30 newest, so a few deleted or hidden ones do not leave the pool short. */
export const OWN_MEDIA_LIMIT = 50;

/**
 * The main Business Discovery field expression for one username (03 §1). `name` is not in it: it is not a field Business
 * Discovery promises for another account, and ONE unknown field fails the whole call (`graph.ts` batch note), so it is asked
 * in its own batch item. `profile_picture_url` is never requested (the owner's rule on images). The username is spliced
 * between parentheses, so only a normalised handle may reach this.
 */
export function discoveryMainFields(handle: string): string {
    return `business_discovery.username(${handle}){username,biography,website,followers_count,media_count,`
        + `media.limit(${DISCOVERY_MEDIA_LIMIT}){${MEDIA_FIELDS},view_count}}`;
}

export const discoveryNameFields = (handle: string): string => `business_discovery.username(${handle}){name}`;

const asGet = (igUserId: string, fields: string): string => `${igUserId}?fields=${encodeURIComponent(fields)}`;

/** The failure of one batch outcome, for classification. */
const failureOf = (o: Extract<BatchOutcome, { ok: false }>): GraphFailure => o.error;

const usable = (creds: GraphCredentials | null | undefined): creds is GraphCredentials =>
    Boolean(creds && typeof creds.token === 'string' && creds.token && typeof creds.igUserId === 'string' && IG_USER_ID.test(creds.igUserId));

/**
 * Business Discovery for one username, as the platform's own connected account. Failures (03 §1):
 *   `invalid_handle` before any request; `not_readable` for code 110 (does not exist, private or personal: Meta says all
 *   three the same way); `age_gated` for an answer with no profile in it; `rate_limited` for Meta's throttling codes, a 429
 *   or a usage header near the ceiling; `no_access` for a dead token or a missing permission; `upstream` for a 5xx or a
 *   call that never answered. `like_count` is missing on a post whose likes are hidden, and is `null` there.
 */
export async function fetchBusinessDiscovery(creds: GraphCredentials | null | undefined, typedHandle: string): Promise<SourceResult<IgProfile>> {
    const handle = normalizeInstagramHandle(typedHandle);
    if (!handle) return sourceFail('instagram_discovery', 'invalid_handle', 'That is not an Instagram username.');
    if (!usable(creds)) return sourceFail('instagram_discovery', 'not_configured', 'No Instagram account is connected for the platform to read with.');

    const session = new GraphSession(creds.token);
    const started = Date.now();
    const [main, name] = await session.batch([
        { relative_url: asGet(creds.igUserId, discoveryMainFields(handle)) },
        { relative_url: asGet(creds.igUserId, discoveryNameFields(handle)) },
    ]);
    if (!main || !main.ok) {
        const failure: GraphFailure = main && !main.ok ? failureOf(main) : { code: null, subcode: null, message: 'Instagram sent no answer.', status: null };
        return finish('instagram_discovery', handle, started, session,
            { ok: false, error: classifyGraphFailure('instagram_discovery', failure, { throttled: session.throttled, secrets: [creds.token] }) });
    }
    return finish('instagram_discovery', handle, started, session, mapDiscoveryProfile(handle, main.body, name?.ok ? name.body : undefined));
}

/**
 * The tenant's own account with their own token: the user node and `/media` in one batch, no comment text (privacy). The
 * 30 newest posts are kept. When `typedHandle` is given and is not the connected account's username, the profile says
 * `handleMismatch` and the wizard asks "is this you?". A media list that fails while the user node answers leaves the
 * profile with no posts and `postsError` set: the bio and the website are still worth reading.
 */
export async function fetchOwnInstagram(creds: GraphCredentials | null | undefined, typedHandle: string | null = null): Promise<SourceResult<IgProfile>> {
    const typed = typedHandle === null || typedHandle === '' ? null : normalizeInstagramHandle(typedHandle);
    if (typedHandle && !typed) return sourceFail('instagram_own', 'invalid_handle', 'That is not an Instagram username.');
    if (!usable(creds)) return sourceFail('instagram_own', 'not_configured', 'Instagram is not connected for this tenant.');

    const session = new GraphSession(creds.token);
    const started = Date.now();
    const outcomes = await session.batch([
        { relative_url: `${creds.igUserId}?fields=username,name,biography,website,followers_count,media_count` },
        { relative_url: `${creds.igUserId}/media?fields=${MEDIA_FIELDS}&limit=${OWN_MEDIA_LIMIT}` },
    ]);
    const [user, media] = outcomes;
    if (!user || !user.ok) {
        const failure: GraphFailure = user && !user.ok ? failureOf(user) : { code: null, subcode: null, message: 'Instagram sent no answer.', status: null };
        return finish('instagram_own', typed, started, session,
            { ok: false, error: classifyGraphFailure('instagram_own', failure, { throttled: session.throttled, secrets: [creds.token] }) });
    }
    const mapped = mapOwnProfile(typed, user.body, media?.ok ? media.body : undefined);
    if (mapped.ok && !(media?.ok)) {
        const failure: GraphFailure = media && !media.ok ? failureOf(media) : { code: null, subcode: null, message: 'Instagram sent no answer for the posts.', status: null };
        mapped.value.postsError = classifyGraphFailure('instagram_own', failure, { throttled: session.throttled, secrets: [creds.token] });
    }
    return finish('instagram_own', typed, started, session, mapped);
}

/** What `probeBusinessDiscovery` found: Meta's own body, or the failure, and how many HTTP requests it took. */
export type DiscoveryProbe =
    | { ok: true; body: unknown; requests: number; ms: number }
    | { ok: false; failure: GraphFailure; requests: number; ms: number };

/**
 * ONE Business Discovery GET with the main field expression, for the probe script (`scripts/probe-business-discovery.mts`):
 * the same expression `fetchBusinessDiscovery` sends, through the same `GraphSession.get`, but un-mapped, so the caller can
 * see exactly which fields Meta returned. It reads; it never writes. The failure is reduced to code, subcode, status and a
 * message scrubbed of the token. `handle` must already be normalised.
 */
export async function probeBusinessDiscovery(creds: GraphCredentials, handle: string): Promise<DiscoveryProbe> {
    const started = Date.now();
    const session = new GraphSession(creds.token);
    try {
        const body = await session.get(creds.igUserId, { fields: discoveryMainFields(handle) });
        return { ok: true, body, requests: session.requests, ms: Date.now() - started };
    } catch (err) {
        const failure = graphFailure(err);
        return { ok: false, failure: { ...failure, message: scrubSecrets(failure.message, [creds.token]) }, requests: session.requests, ms: Date.now() - started };
    }
}

/** One log line per read, with no credential in it, and the result passed through. */
function finish(source: 'instagram_discovery' | 'instagram_own', handle: string | null, started: number, session: GraphSession, result: SourceResult<IgProfile>): SourceResult<IgProfile> {
    try {
        const fields = { source, handle, ms: Date.now() - started, requests: session.requests, throttled: session.throttled };
        if (result.ok) {
            log('info', 'onboarding.ig_source', { ...fields, posts: result.value.posts.length, followers: result.value.followers, posts_error: result.value.postsError?.kind ?? null });
        } else {
            log(result.error.kind === 'upstream' || result.error.kind === 'rate_limited' ? 'warn' : 'info', 'onboarding.ig_source_failed',
                { ...fields, kind: result.error.kind, retryable: result.error.retryable, code: result.error.code, http_status: result.error.http_status, message: result.error.message });
        }
    } catch (err) {
        log('warn', 'onboarding.ig_source_log_failed', describeError(err));
    }
    return result;
}
