/**
 * Who an Instagram DM sender is, kept on their conversation (migration v40).
 *
 * `conversations.username` was never written, so the inbox showed every Instagram sender as "User 3051". Meta's Instagram User Profile API
 * answers the question once a person has messaged the business; `fetchInstagramUserProfile` (instagram.ts) makes the call and this file
 * decides WHEN and what a failure means.
 *
 * Two rules, both from the owner's brief:
 *
 *   - **Best effort.** A lookup that fails is logged (`dm.profile_failed`) and the DM is answered exactly as it would have been. Nothing in
 *     here throws: `refreshSenderProfile` resolves to an outcome, whatever happened, including a database that has not had v40 applied.
 *   - **Throttled.** On first contact, then at most once a day. A failure counts as an attempt too (a person who blocked the business, or never
 *     consented, would otherwise be asked about on every message), but while there is still no successful lookup it is retried after an hour,
 *     since nothing is lost by asking again and the name is what the operator is waiting for. The throttle is ONE `UPDATE … RETURNING` that claims
 *     the attempt (`profile_checked_at`), so two DMs a second apart, or a DM and the operator opening the thread, make one call between them.
 *
 * Callers: the DM pipeline (src/webhook/messaging.ts, after the inbound message is claimed) and the inbox's own refresh
 * (`POST /api/conversations/:id/refresh-profile`, which is how a thread written before v40 fills in the first time the operator opens it).
 */
import { queryOne } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import { fetchInstagramUserProfile, type InstagramUserProfile } from './instagram.js';

/** At most one lookup per conversation per day once one has succeeded. */
export const PROFILE_REFRESH_SECONDS = 24 * 60 * 60;
/** While none has succeeded, one an hour. */
export const PROFILE_RETRY_SECONDS = 60 * 60;
/**
 * How old a profile is before the inbox asks for a refresh when it opens the thread. The same day as the throttle, so a thread the
 * server would refuse to refresh is not asked about, and Meta's picture link (good for "a few days") is replaced while it still works.
 */
export const PROFILE_STALE_MS = PROFILE_REFRESH_SECONDS * 1000;

/**
 * After a DM's outcome is decided, the longest its job waits for the profile lookup that started beside it. A lookup is two Graph calls
 * at worst (the full field list, then the three that identify a person), each with its own retry, so a slow Meta could otherwise hold
 * the job for the better part of a minute AFTER the reply has gone out and the message is marked handled. Past this, the job finishes
 * without it: the attempt is already recorded (`profile_checked_at`), so nothing is lost but a day's wait for a name.
 */
export const PROFILE_WAIT_MS = 5_000;

/**
 * Wait for `task` for at most `ms`, then stop waiting (the task keeps going). Resolves either way and never rejects, and clears its
 * timer when the task finishes first, so a fast lookup leaves nothing pending.
 */
export async function settleWithin(task: Promise<unknown>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
    try {
        await Promise.race([task.then(() => undefined, () => undefined), deadline]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/** What `refreshSenderProfile` did. `skipped`: nothing to look up (no token, not an Instagram thread). */
export type ProfileRefreshOutcome = 'refreshed' | 'throttled' | 'failed' | 'skipped';

/** The columns this file owns, as the inbox reads them. */
export interface ConversationProfileRow {
    username: string | null;
    profile_name: string | null;
    profile_pic_url: string | null;
    follower_count: number | null;
    is_user_follow_business: boolean | null;
    is_business_follow_user: boolean | null;
    is_verified_user: boolean | null;
    profile_fetched_at: string | Date | null;
    profile_checked_at: string | Date | null;
}

export interface ProfileRefreshResult {
    outcome: ProfileRefreshOutcome;
    /** The stored profile after a `refreshed`; absent otherwise. */
    profile?: ConversationProfileRow;
}

export interface ProfileRefreshInput {
    conversationId: string;
    /** The sender's Instagram-scoped id (`conversations.instagram_user_id`). */
    igsid: string;
    /** The tenant's Page access token, decrypted; null for a tenant with no Meta connection. */
    token: string | null | undefined;
}

export interface ProfileRefreshDeps {
    fetchProfile?: (igsid: string, token: string) => Promise<InstagramUserProfile>;
}

/**
 * Take the right to look this sender up, or learn that someone has, recently. The whole throttle is this statement.
 *
 * The two `::float8` casts are load-bearing: `make_interval(secs => …)` wants a double, and a `CASE` of two untyped parameters resolves to
 * text, which it refuses.
 */
export const CLAIM_PROFILE_SQL = `UPDATE conversations
        SET profile_checked_at = NOW()
      WHERE id = $1
        AND (profile_checked_at IS NULL
             OR profile_checked_at < NOW() - make_interval(secs => CASE WHEN profile_fetched_at IS NULL THEN $2::float8 ELSE $3::float8 END))
  RETURNING id`;

/** Writes what Meta said. COALESCE: a partial answer fills what it has and never blanks what an earlier one found. */
export const STORE_PROFILE_SQL = `UPDATE conversations
        SET username = COALESCE($2, username),
            profile_name = COALESCE($3, profile_name),
            profile_pic_url = COALESCE($4, profile_pic_url),
            follower_count = COALESCE($5::int, follower_count),
            is_user_follow_business = COALESCE($6::boolean, is_user_follow_business),
            is_business_follow_user = COALESCE($7::boolean, is_business_follow_user),
            is_verified_user = COALESCE($8::boolean, is_verified_user),
            profile_fetched_at = NOW()
      WHERE id = $1
  RETURNING username, profile_name, profile_pic_url, follower_count, is_user_follow_business,
            is_business_follow_user, is_verified_user, profile_fetched_at, profile_checked_at`;

/**
 * Look one sender up, if the throttle allows, and store the answer. Never throws.
 *
 * Order: claim first, call Meta second. A failure after the claim is therefore throttled like a success, which is the point.
 */
export async function refreshSenderProfile(
    input: ProfileRefreshInput,
    deps: ProfileRefreshDeps = {}
): Promise<ProfileRefreshResult> {
    const { conversationId, igsid, token } = input;
    if (!token || !igsid) return { outcome: 'skipped' };
    const fetchProfile = deps.fetchProfile ?? fetchInstagramUserProfile;

    try {
        const claimed = await queryOne<{ id: string }>(CLAIM_PROFILE_SQL, [
            conversationId, PROFILE_RETRY_SECONDS, PROFILE_REFRESH_SECONDS,
        ]);
        if (!claimed) return { outcome: 'throttled' };

        const profile = await fetchProfile(igsid, token);

        const stored = await queryOne<ConversationProfileRow>(STORE_PROFILE_SQL, [
            conversationId,
            profile.username, profile.name, profile.profilePic, profile.followerCount,
            profile.followsBusiness, profile.businessFollows, profile.verified,
        ]);
        return stored ? { outcome: 'refreshed', profile: stored } : { outcome: 'failed' };
    } catch (err) {
        // The conversation id, never the name or the picture: those are the person's, and a log line outlives the thread.
        log('warn', 'dm.profile_failed', {
            conversation_id: conversationId,
            ...describeError(err),
            ...(typeof (err as { metaCode?: unknown })?.metaCode === 'number' ? { meta_code: (err as { metaCode: number }).metaCode } : {}),
        });
        return { outcome: 'failed' };
    }
}
