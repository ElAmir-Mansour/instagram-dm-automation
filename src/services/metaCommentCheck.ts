/**
 * "Did a comment reach us?" — the setup wizard's test-comment check (plan P28; docs/onboarding/04 §3).
 *
 * After a tenant connects Instagram the wizard asks someone else to comment "test" on one of their posts, and turns green when it
 * arrives. What it watches is the QUEUE, not the campaigns: the webhook writes every comment event to `jobs` as a `comment.process`
 * job before anything looks at it, so a job proves the whole delivery path (Meta's subscription, the signature, our endpoint, the
 * queue), which is exactly the part that is unverified for a tenant who holds only a Tester role on the app. It cannot use
 * `last_comment_at` (`health.ts`): that counts only comments that matched a campaign, and a new tenant has none. And it does not
 * matter that the pipeline later drops the tenant's OWN comment (the self-author guard, FLOWS.md §1.8): the job already exists.
 *
 * ─── Which jobs are this tenant's ────────────────────────────────────────────
 * Not `jobs.creator_id`. The webhook writes that column NULL on every row (a job is enqueued before the tenant is resolved, to get
 * off Meta's clock first; `planJobs`), and puts the Meta id the delivery was addressed to (`entry.id`: the Instagram account's id, or
 * the Page's) in `tenant_key`. So a tenant's jobs are the ones whose `tenant_key` is one of ITS two ids, or (should a later change
 * start filling it in) whose `creator_id` is the tenant. Both are bound to the tenant of the SESSION: the route passes
 * `getTenantId(req)` and nothing from the request, so one tenant cannot ask about another's Page.
 *
 * ─── What it says ────────────────────────────────────────────────────────────
 * A count and the time of the latest job. Never a payload: a job's payload is the comment itself (its text, the commenter), which
 * this check has no business returning.
 *
 * "After when": the moment the tenant connected (`meta_connected_at`), so a comment from before the connection is not mistaken for
 * proof. A connection an operator made by pasting a token has no such moment, and counts the last `FALLBACK_WINDOW_MS`.
 */
import { queryOne } from '../db/query.js';

/** For a connection with no recorded time: a comment in the last day proves the path as well as one a minute ago. */
export const FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CommentCheck {
    /** Is there a Meta connection to watch? When not, nothing else is asked. */
    connected: boolean;
    /** Jobs are counted after this instant (ISO). Null when not connected. */
    since: string | null;
    received: boolean;
    count: number;
    /** When the latest counted job was created (ISO), or null. */
    latestAt: string | null;
}

/** The tenant's check, or null when the tenant does not exist. */
export async function readCommentCheck(creatorId: string, now: number = Date.now()): Promise<CommentCheck | null> {
    const creator = await queryOne<{
        instagram_page_id: string | null; facebook_page_id: string | null; connected: boolean; meta_connected_at: Date | string | null;
    }>(
        `SELECT instagram_page_id, facebook_page_id, (page_access_token IS NOT NULL) AS connected, meta_connected_at
           FROM creators WHERE id = $1`,
        [creatorId]
    );
    if (!creator) return null;
    if (!creator.connected) return { connected: false, since: null, received: false, count: 0, latestAt: null };

    const since = creator.meta_connected_at ? new Date(creator.meta_connected_at) : new Date(now - FALLBACK_WINDOW_MS);
    const keys = [creator.instagram_page_id, creator.facebook_page_id].filter((k): k is string => Boolean(k));

    const row = await queryOne<{ count: number | string; latest: Date | string | null }>(
        `SELECT COUNT(*)::int AS count, MAX(created_at) AS latest
           FROM jobs
          WHERE kind = 'comment.process'
            AND created_at > $2
            AND (creator_id = $1 OR tenant_key = ANY($3::text[]))`,
        [creatorId, since, keys]
    );
    const count = Number(row?.count ?? 0);
    return {
        connected: true,
        since: since.toISOString(),
        received: count > 0,
        count,
        latestAt: row?.latest ? new Date(row.latest).toISOString() : null,
    };
}
