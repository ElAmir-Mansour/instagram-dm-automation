/**
 * Tests only: a one-row `scheduled_posts` table and a job queue in memory, answering exactly the statements `firstComment.ts` sends, the way Postgres would
 * (including the compare-and-set guards in their WHERE clauses: a statement that drops a guard is run as written, so the test fails). Nothing here is
 * imported by production code.
 */
import { pool } from '../config/db.js';
import type { FirstCommentEntry, FirstCommentStatus } from '../db/rows.js';
import { setJobQueue } from '../jobs/queue.js';
import type { EnqueueInput, JobQueue } from '../jobs/types.js';

export interface FakePost {
    id: string;
    creator_id: string;
    platform: string;
    status: string;
    first_comment: string | null;
    first_comment_status: FirstCommentStatus | null;
    published_post_id: string | null;
}

export interface FakeWorld {
    post: FakePost | null;
    token: string | null;
    enqueued: EnqueueInput[];
    dedupeKeys: Set<string>;
    /** When set, `enqueue` throws it. */
    enqueueError: Error | null;
    sql: string[];
}

export function installFakeWorld(post: FakePost | null): { world: FakeWorld; restore: () => void } {
    const world: FakeWorld = { post, token: 'plain-page-token', enqueued: [], dedupeKeys: new Set(), enqueueError: null, sql: [] };
    const originalQuery = pool.query;
    (pool as unknown as { query: unknown }).query = async (rawSql: string, params: any[] = []) => {
        const sql = rawSql.replace(/\s+/g, ' ').trim();
        world.sql.push(sql);
        const p = world.post;
        const own = p && p.id === params[0];

        // writeEntry
        if (/^UPDATE scheduled_posts SET first_comment_status = jsonb_set\(COALESCE\(/.test(sql)) {
            if (!own) return { rows: [], rowCount: 0 };
            const platform = params[1] as 'instagram' | 'facebook';
            const current = p!.first_comment_status?.[platform];
            if (/IS NULL OR first_comment_status -> \$2::text IS NULL/.test(sql) && current) return { rows: [], rowCount: 0 };
            const from = /->> 'status' = '(\w+)'/.exec(sql)?.[1];
            if (from && current?.status !== from) return { rows: [], rowCount: 0 };
            p!.first_comment_status = { ...(p!.first_comment_status ?? {}), [platform]: JSON.parse(params[2]) as FirstCommentEntry };
            return { rows: [{ id: p!.id }], rowCount: 1 };
        }
        // the job's claim
        if (/^UPDATE scheduled_posts SET first_comment_status = jsonb_set\(first_comment_status, ARRAY\[\$2::text\], \$4::jsonb\)/.test(sql)) {
            const platform = params[1] as 'instagram' | 'facebook';
            if (!own || p!.creator_id !== params[2]) return { rows: [], rowCount: 0 };
            if (!/status = 'PUBLISHED'/.test(sql) || !/->> 'status' = 'pending'/.test(sql)) throw new Error(`the claim lost a guard: ${sql}`);
            if (p!.status !== 'PUBLISHED' || p!.first_comment_status?.[platform]?.status !== 'pending') return { rows: [], rowCount: 0 };
            p!.first_comment_status = { ...p!.first_comment_status, [platform]: JSON.parse(params[3]) as FirstCommentEntry };
            return { rows: [{ first_comment: p!.first_comment, published_post_id: p!.published_post_id }], rowCount: 1 };
        }
        // cleared before send
        if (/^UPDATE scheduled_posts SET first_comment_status = first_comment_status - \$2::text/.test(sql)) {
            if (!own) return { rows: [], rowCount: 0 };
            const next = { ...p!.first_comment_status };
            delete next[params[1] as 'instagram' | 'facebook'];
            p!.first_comment_status = next;
            return { rows: [{ id: p!.id }], rowCount: 1 };
        }
        if (/^SELECT status, first_comment_status FROM scheduled_posts WHERE id = \$1 AND creator_id = \$2$/.test(sql)) {
            return own && p!.creator_id === params[1] ? { rows: [{ status: p!.status, first_comment_status: p!.first_comment_status }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/^SELECT page_access_token FROM creators WHERE id = \$1$/.test(sql)) {
            return { rows: world.token === null ? [] : [{ page_access_token: world.token }], rowCount: world.token === null ? 0 : 1 };
        }
        // What `attemptPublish` writes to the row's own status (so a test can see the order, and that the comment never writes one)
        if (/^UPDATE scheduled_posts SET status = 'PUBLISHED', published_post_id = \$1/.test(sql)) {
            if (p && p.id === params[1]) { p.status = 'PUBLISHED'; p.published_post_id = params[0]; }
            return { rows: [], rowCount: 1 };
        }
        if (/^UPDATE scheduled_posts SET status = '(PENDING)', claimed_at = NULL, external_publish_id = \$1/.test(sql)) {
            if (p && p.id === params[3]) { p.status = 'PENDING'; p.published_post_id = params[1]; }
            return { rows: [], rowCount: 1 };
        }
        if (/^UPDATE scheduled_posts SET status = 'FAILED'/.test(sql)) {
            if (p && p.id === params[2]) { p.status = 'FAILED'; p.published_post_id = params[1]; }
            return { rows: [], rowCount: 1 };
        }
        throw new Error(`no result arranged for SQL: ${sql}`);
    };
    const queue: JobQueue = {
        async enqueue(input: EnqueueInput) {
            if (world.enqueueError) throw world.enqueueError;
            if (input.dedupeKey) {
                if (world.dedupeKeys.has(input.dedupeKey)) return null;
                world.dedupeKeys.add(input.dedupeKey);
            }
            world.enqueued.push(input);
            return `job-${world.enqueued.length}`;
        },
        async claim() { return []; },
        async complete() {},
        async fail() {},
        async reapStale() { return 0; },
        async releaseUnrun() { return 0; },
    } as unknown as JobQueue;
    const previousQueue = setJobQueue(queue);
    return {
        world,
        restore: () => {
            (pool as unknown as { query: unknown }).query = originalQuery;
            setJobQueue(previousQueue);
        },
    };
}
