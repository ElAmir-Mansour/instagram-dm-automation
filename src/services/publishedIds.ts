/**
 * `scheduled_posts.published_post_id`: `FB:<id>`, `IG:<id>` or `FB:<id> | IG:<id>`.
 *
 * Lifted out of src/routes/api.ts, which re-exports both, so the Growth sync can link a post's
 * insights to the row that published it without importing the router.
 */

/**
 * Which platforms a row has already been published to.
 *
 * `published_post_id` holds `FB:<id>`, `IG:<id>` or `FB:<id> | IG:<id>`. That string was only
 * ever written on full success, which hid a real problem: on `platform = 'both'`, Facebook is
 * published first, so a Facebook success followed by an Instagram failure threw away the
 * Facebook post id and recorded the row as FAILED. The post *was* live on Facebook. Editing
 * the row (which flips FAILED back to PENDING) then republished it, so the honest-looking
 * "retry" duplicated the Facebook post on the live account — the exact outcome the atomic
 * claim beside it was written to prevent.
 *
 * Recording the partial success and reading it back on the next attempt is what makes a retry
 * finish the job instead of doing half of it twice.
 */
export function publishedPlatforms(publishedPostId: unknown): { fb: string | null; ig: string | null } {
    if (typeof publishedPostId !== 'string') return { fb: null, ig: null };
    const fb = /(?:^|\s)FB:([^\s|]+)/.exec(publishedPostId);
    const ig = /(?:^|\s)IG:([^\s|]+)/.exec(publishedPostId);
    return { fb: fb?.[1] ?? null, ig: ig?.[1] ?? null };
}

/** The `FB:… | IG:…` string, from whatever ids exist. Empty when neither does. */
export function formatPublishedIds(fbId: string | null, igId: string | null): string {
    if (fbId && igId) return `FB:${fbId} | IG:${igId}`;
    if (fbId) return `FB:${fbId}`;
    if (igId) return `IG:${igId}`;
    return '';
}
