/**
 * "Is this tenant working right now?"
 *
 * `scripts/diagnose.mjs` already answers this, thoroughly, from a checkout with the Meta app
 * credentials to hand. That is the wrong place for the ordinary operator: it needs a terminal,
 * a `.env`, and somebody who knows the script exists. The dashboard had no screen answering
 * it at all — `last_webhook_at` existed on exactly one admin endpoint, and this project's own
 * notes call a webhook signature failure *invisible*, because the 403 happens before anything
 * touches the database and "rejected" and "nobody messaged us" look identical from the inside.
 *
 * So the queries here are the database half of diagnose.mjs, lifted into the app: the same
 * signals, the same thresholds, minus everything that needs an outbound Meta call. What is
 * deliberately NOT here is the half diagnose.mjs exists for — webhook subscription callback
 * URLs, the verify-token handshake, live `debug_token` scope checks. Those need the app
 * credentials and an HTTP round-trip per tenant, and they do not belong on a page load.
 *
 * ── The one insight worth stating ──
 *
 * `lastWebhookAt` must not be derived from `interactions` and `messages` alone. A comment that
 * matches no campaign writes **no interactions row at all**, so a tenant whose keywords all
 * stopped matching looks exactly like a tenant whose deliveries stopped arriving — and those
 * need completely different fixes. Since migration v13, every delivery writes a `jobs` row
 * before Meta is acknowledged, matched or not. `jobs` is therefore the only honest evidence
 * that a webhook arrived, and it is folded into `lastWebhookAt` below.
 */
import { queryOne, queryRows } from '../db/query.js';
import { compareSchema, type SchemaState } from '../config/migrations.js';
import { CLAIM_VISIBILITY_SECONDS } from '../jobs/runner.js';
import { DEFAULT_HOURLY_LIMIT } from '../utils/rateLimiter.js';
import { interactionsOwnedBy, interactionsOwnedByExpr } from './tenant.js';
import { describeError, log } from '../utils/log.js';

/** Supabase free tier. `media_uploads` is BYTEA and grows with every video. */
export const STORAGE_TIER_BYTES = 500 * 1024 * 1024;

/**
 * Longest keyword still considered dangerous under substring matching.
 *
 * `scripts/diagnose.mjs` uses `length < 3`, i.e. one and two characters. That threshold misses
 * the case this endpoint exists to surface: `عيد` is three characters and fires inside `سعيد`,
 * which is a word people actually write. Three it is — and `matchMode` travels with every row
 * so the dashboard can tell a genuine hazard from a short keyword whose campaign has already
 * been switched to `word` matching, where the length does not matter.
 */
export const SHORT_KEYWORD_MAX_LENGTH = 3;

// ─── When the schema is behind the code ─────────────────────────────────────────────────
//
// Migration v15 adds `audit_log` and two `creators` columns, and the queries below select
// them. A pending migration does not announce itself in this app — the usual symptom is a
// query failing on an unknown column and the page rendering "Failed to load", which points
// nowhere. These two turn that into a one-line instruction.

/** Postgres `undefined_table`. */
export const PG_UNDEFINED_TABLE = '42P01';
/** Postgres `undefined_column`. */
export const PG_UNDEFINED_COLUMN = '42703';

export const MIGRATION_HINT =
    'The database is missing migration v15 (src/config/migration_v15_admin.sql). '
    + 'Apply it with `npm run migrate`, then reload.';

export function isMissingSchema(err: unknown): boolean {
    const code = (err as { code?: unknown } | null)?.code;
    return code === PG_UNDEFINED_TABLE || code === PG_UNDEFINED_COLUMN;
}

/** `pg` hands back a Date; the wire wants an ISO string or null, never `"Invalid Date"`. */
export function toIso(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value as string);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The newest of several timestamps, ignoring the absent ones. */
export function newestOf(...values: unknown[]): string | null {
    let best: number | null = null;
    for (const value of values) {
        const iso = toIso(value);
        if (!iso) continue;
        const ms = Date.parse(iso);
        if (best === null || ms > best) best = ms;
    }
    return best === null ? null : new Date(best).toISOString();
}

export interface QueueCounts {
    pending: number;
    running: number;
    failed: number;
}

export interface TenantHealth {
    tenantId: string;
    tokenStatus: string | null;
    tokenLastCheckedAt: string | null;
    tokenError: string | null;
    tokenExpiresAt: string | null;
    dataAccessExpiresAt: string | null;
    /** Newest inbound signal of ANY kind — comment, DM, or a queued delivery that matched nothing. */
    lastWebhookAt: string | null;
    lastCommentAt: string | null;
    lastInboundDmAt: string | null;
    dmThisHour: number;
    dmCeiling: number;
    queue: QueueCounts;
    postsPending: number;
    postsFailed7d: number;
}

/** A tenant's health plus the identity a cross-tenant table needs to label the row. */
export interface TenantHealthRow extends TenantHealth {
    name: string | null;
    isActive: boolean;
    instagramPageId: string | null;
    facebookPageId: string | null;
}

/** Shape the health query returns, before it is mapped to the wire type. */
interface HealthDbRow {
    id: string;
    name: string | null;
    is_active: boolean;
    instagram_page_id: string | null;
    facebook_page_id: string | null;
    token_status: string | null;
    token_last_checked_at: Date | null;
    token_error: string | null;
    token_expires_at: Date | null;
    token_data_access_expires_at: Date | null;
    last_comment_at: Date | null;
    last_inbound_dm_at: Date | null;
    last_job_at: Date | null;
    dm_this_hour: number;
    jobs_pending: number;
    jobs_running: number;
    jobs_failed: number;
    posts_pending: number;
    posts_failed_7d: number;
}

/**
 * One row per tenant, with every number the health view shows.
 *
 * `$1` is a tenant id or NULL for "all of them", so `/api/health/tenant` and
 * `/api/admin/ops` run the same SQL and cannot disagree about what "healthy" means. The
 * lateral joins are one pass over `jobs` and `scheduled_posts` per tenant rather than three
 * correlated subqueries each.
 *
 * The `jobs` predicate is the awkward one and it has to be. `jobs.creator_id` is NULL on
 * everything the webhook writes — resolving the tenant needs a database read and the whole
 * point of enqueueing is to acknowledge Meta before doing any — so the tenant is identified by
 * `tenant_key`, which carries `entry.id`, the Meta page id the delivery was addressed to.
 * Matching both columns is what makes this work for webhook rows and for anything enqueued
 * with a known tenant. No index covers that OR, so this is a sequential scan of `jobs`;
 * acceptable because completed rows are pruned weekly (`DONE_JOB_RETENTION_DAYS`) and the
 * table holds hours of work, not history.
 */
const TENANT_HEALTH_SQL = `
    SELECT
        c.id,
        c.name,
        c.is_active,
        c.instagram_page_id,
        c.facebook_page_id,
        c.token_status,
        c.token_last_checked_at,
        c.token_error,
        c.token_expires_at,
        c.token_data_access_expires_at,

        -- Comments that matched a campaign. Goes through the ownership predicate rather than
        -- the bare column because rows written before the tenancy pass have creator_id NULL.
        (SELECT MAX(i.timestamp) FROM interactions i WHERE ${interactionsOwnedByExpr('c.id')}) AS last_comment_at,

        -- DMs, reached through the conversation: conversations.creator_id is the reliable
        -- tenant key, which is why src/services/tenant.ts has no predicate for messages.
        (SELECT MAX(m.created_at)
           FROM messages m
           JOIN conversations cv ON cv.id = m.conversation_id
          WHERE cv.creator_id = c.id AND m.direction = 'inbound') AS last_inbound_dm_at,

        COALESCE((SELECT r.count FROM rate_limit_counters r
                   WHERE r.creator_id = c.id AND r.bucket = 'dm'
                     AND r.window_start = date_trunc('hour', NOW())), 0)::int AS dm_this_hour,

        q.last_job_at,
        q.jobs_pending,
        q.jobs_running,
        q.jobs_failed,
        p.posts_pending,
        p.posts_failed_7d
    FROM creators c
    LEFT JOIN LATERAL (
        SELECT
            MAX(j.created_at)                                        AS last_job_at,
            COUNT(*) FILTER (WHERE j.status = 'pending')::int        AS jobs_pending,
            COUNT(*) FILTER (WHERE j.status = 'running')::int        AS jobs_running,
            COUNT(*) FILTER (WHERE j.status = 'failed')::int         AS jobs_failed
          FROM jobs j
         WHERE j.creator_id = c.id
            OR (j.tenant_key IS NOT NULL
                AND j.tenant_key IN (c.instagram_page_id, c.facebook_page_id))
    ) q ON TRUE
    LEFT JOIN LATERAL (
        SELECT
            COUNT(*) FILTER (WHERE s.status = 'PENDING')::int AS posts_pending,
            COUNT(*) FILTER (WHERE s.status = 'FAILED'
                               AND s.scheduled_time > NOW() - INTERVAL '7 days')::int AS posts_failed_7d
          FROM scheduled_posts s
         WHERE s.creator_id = c.id
    ) p ON TRUE
    WHERE $1::uuid IS NULL OR c.id = $1::uuid
    ORDER BY c.name NULLS LAST, c.created_at
`;

function toTenantHealthRow(row: HealthDbRow): TenantHealthRow {
    return {
        tenantId: row.id,
        name: row.name,
        isActive: row.is_active,
        instagramPageId: row.instagram_page_id,
        facebookPageId: row.facebook_page_id,
        tokenStatus: row.token_status,
        tokenLastCheckedAt: toIso(row.token_last_checked_at),
        tokenError: row.token_error,
        tokenExpiresAt: toIso(row.token_expires_at),
        dataAccessExpiresAt: toIso(row.token_data_access_expires_at),
        // The whole point. A queued delivery counts even when it matched nothing, because a
        // tenant whose keywords stopped matching and a tenant whose deliveries stopped
        // arriving are otherwise indistinguishable — and only one of those is an outage.
        lastWebhookAt: newestOf(row.last_comment_at, row.last_inbound_dm_at, row.last_job_at),
        lastCommentAt: toIso(row.last_comment_at),
        lastInboundDmAt: toIso(row.last_inbound_dm_at),
        dmThisHour: row.dm_this_hour,
        dmCeiling: DEFAULT_HOURLY_LIMIT,
        queue: {
            pending: row.jobs_pending ?? 0,
            running: row.jobs_running ?? 0,
            failed: row.jobs_failed ?? 0,
        },
        postsPending: row.posts_pending ?? 0,
        postsFailed7d: row.posts_failed_7d ?? 0,
    };
}

/** Health for one tenant, or null when there is no such creator. */
export async function getTenantHealth(tenantId: string): Promise<TenantHealth | null> {
    const row = await queryOne<HealthDbRow & Record<string, unknown>>(TENANT_HEALTH_SQL, [tenantId]);
    if (!row) return null;

    // The identity fields are dropped here: the caller already knows which tenant it asked
    // about, and `/api/health/tenant` is the one endpoint a non-admin reaches, so it should
    // not hand back a page id nobody asked for.
    const { name, isActive, instagramPageId, facebookPageId, ...health } = toTenantHealthRow(row);
    return health;
}

/** Health for every tenant, for the cross-tenant admin view. */
export async function getAllTenantHealth(): Promise<TenantHealthRow[]> {
    const rows = await queryRows<HealthDbRow & Record<string, unknown>>(TENANT_HEALTH_SQL, [null]);
    return rows.map(toTenantHealthRow);
}

// ─── Global: the queue ──────────────────────────────────────────────────────────────────

export interface GlobalQueueHealth extends QueueCounts {
    done: number;
    cancelled: number;
    /**
     * The oldest job that is DUE and still unclaimed, as an ISO timestamp, or null when there
     * is none. Its age is the operator's headline number: the inline drain only runs when a
     * webhook arrives and the Vercel cron runs once a day, so anything more than a few minutes
     * old means nothing is draining and an external scheduler needs pointing at
     * `GET /api/jobs/drain`.
     *
     * Filtered on `run_after <= NOW()` deliberately. A job deliberately scheduled for next
     * Tuesday is not stranded, and reporting it as the oldest pending item would make a
     * healthy queue look stuck.
     */
    oldestPendingAt: string | null;
    /**
     * Claims older than the visibility timeout — an invocation died holding them.
     *
     * These are the jobs that are invisible without this number: a job frozen mid-flight sits
     * at `running`, so it is not pending, not failed and not done, and the only two things
     * that reap it are the next webhook and the daily cron.
     */
    stale: number;
}

export async function getQueueHealth(): Promise<GlobalQueueHealth> {
    const row = await queryOne<{
        pending: number; running: number; failed: number; done: number; cancelled: number;
        oldest_pending_at: Date | null; stale: number;
    }>(
        `SELECT
             COUNT(*) FILTER (WHERE status = 'pending')::int   AS pending,
             COUNT(*) FILTER (WHERE status = 'running')::int   AS running,
             COUNT(*) FILTER (WHERE status = 'failed')::int    AS failed,
             COUNT(*) FILTER (WHERE status = 'done')::int      AS done,
             COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
             MIN(run_after) FILTER (WHERE status = 'pending' AND run_after <= NOW()) AS oldest_pending_at,
             COUNT(*) FILTER (WHERE status = 'running'
                                AND claimed_at < NOW() - make_interval(secs => $1))::int AS stale
           FROM jobs`,
        [CLAIM_VISIBILITY_SECONDS]
    );

    return {
        pending: row?.pending ?? 0,
        running: row?.running ?? 0,
        failed: row?.failed ?? 0,
        done: row?.done ?? 0,
        cancelled: row?.cancelled ?? 0,
        oldestPendingAt: toIso(row?.oldest_pending_at),
        stale: row?.stale ?? 0,
    };
}

// ─── Global: schema drift ───────────────────────────────────────────────────────────────

/**
 * What the ledger says versus what this build expects.
 *
 * Worth surfacing in the dashboard rather than only in a script, because a pending migration
 * does not announce itself: the webhook takes the delivery, an INSERT fails on an unknown
 * column, and the failure looks like every other kind of silence in this app.
 */
export async function getSchemaState(): Promise<SchemaState> {
    try {
        const rows = await queryRows<{ filename: string }>('SELECT filename FROM schema_migrations');
        return compareSchema(rows.map((r) => r.filename));
    } catch (err: any) {
        // No ledger at all — nothing has ever recorded a migration. Every expected migration
        // is therefore "pending", which is the honest answer and the actionable one.
        log('warn', 'health.schema_ledger_unreadable', describeError(err));
        return compareSchema([]);
    }
}

// ─── Global: storage ────────────────────────────────────────────────────────────────────

export interface StorageUsage {
    /** `media_uploads` including indexes and TOAST — the BYTEA video store. */
    mediaBytes: number | null;
    dbBytes: number | null;
    tierBytes: number;
}

export async function getStorageUsage(): Promise<StorageUsage> {
    try {
        const row = await queryOne<{ media_bytes: string; db_bytes: string }>(
            `SELECT pg_total_relation_size('media_uploads') AS media_bytes,
                    pg_database_size(current_database())    AS db_bytes`
        );
        return {
            // `pg` returns int8 as a string to avoid precision loss; these are megabytes, so
            // Number is safe and the dashboard wants a number to do arithmetic on.
            mediaBytes: row ? Number(row.media_bytes) : null,
            dbBytes: row ? Number(row.db_bytes) : null,
            tierBytes: STORAGE_TIER_BYTES,
        };
    } catch (err) {
        // Size functions can be refused by a restricted role. A missing measurement must not
        // take the whole ops page down with it.
        log('warn', 'health.storage_unreadable', describeError(err));
        return { mediaBytes: null, dbBytes: null, tierBytes: STORAGE_TIER_BYTES };
    }
}

// ─── Global: dangerous keywords ─────────────────────────────────────────────────────────

export interface ShortKeyword {
    campaignId: string;
    creatorId: string | null;
    keyword: string;
    length: number;
    matchMode: string;
}

/**
 * Active keywords short enough to fire inside an unrelated word.
 *
 * Split in SQL rather than in TypeScript so this is one query instead of one per campaign.
 * The split rule matches `matchCampaign` in src/services/matching.ts: comma-separated, then
 * trimmed. Length is measured on what the operator typed, because that is what the dashboard
 * shows them next to the warning.
 */
export async function getShortKeywords(): Promise<ShortKeyword[]> {
    const rows = await queryRows<{
        campaign_id: string; creator_id: string | null; keyword: string;
        length: number; match_mode: string | null;
    }>(
        `WITH split AS (
             SELECT c.id AS campaign_id, c.creator_id, c.match_mode, trim(kw) AS keyword
               FROM campaigns c, unnest(string_to_array(c.trigger_keyword, ',')) AS kw
              WHERE c.is_active
         )
         SELECT campaign_id, creator_id, keyword,
                char_length(keyword)::int AS length,
                match_mode
           FROM split
          WHERE keyword <> '' AND char_length(keyword) <= $1
          ORDER BY char_length(keyword), keyword`,
        [SHORT_KEYWORD_MAX_LENGTH]
    );

    return rows.map((r) => ({
        campaignId: r.campaign_id,
        creatorId: r.creator_id,
        keyword: r.keyword,
        length: r.length,
        // A row whose query forgot the column, or a legacy row, means substring — the same
        // default `normalizeMatchMode` applies, for the same reason.
        matchMode: r.match_mode ?? 'substring',
    }));
}

// ─── The whole ops picture ──────────────────────────────────────────────────────────────

export interface OpsSnapshot {
    checkedAt: string;
    dmCeiling: number;
    tenants: TenantHealthRow[];
    queue: GlobalQueueHealth;
    schema: SchemaState;
    storage: StorageUsage;
    shortKeywords: ShortKeyword[];
}

/**
 * Everything the admin ops view shows, in one call.
 *
 * Five independent queries, so they run concurrently: the page is a poll target and the
 * latency is whatever the slowest one is, not the sum. `pool` is capped at 10 connections and
 * this is an admin-only endpoint, so five in flight is not a pressure the webhook path will
 * notice.
 */
export async function getOpsSnapshot(): Promise<OpsSnapshot> {
    const [tenants, queue, schema, storage, shortKeywords] = await Promise.all([
        getAllTenantHealth(),
        getQueueHealth(),
        getSchemaState(),
        getStorageUsage(),
        getShortKeywords(),
    ]);

    return {
        checkedAt: new Date().toISOString(),
        dmCeiling: DEFAULT_HOURLY_LIMIT,
        tenants,
        queue,
        schema,
        storage,
        shortKeywords,
    };
}

/** Kept for the tenant-detail endpoint, which wants counts the health row does not carry. */
export interface TenantCounts {
    campaigns: number;
    activeCampaigns: number;
    scheduledPosts: number;
    conversations: number;
    interactions: number;
    messages: number;
}

export async function getTenantCounts(tenantId: string): Promise<TenantCounts> {
    const row = await queryOne<Record<keyof TenantCounts, number>>(
        `SELECT
             (SELECT COUNT(*) FROM campaigns       WHERE creator_id = $1)::int AS campaigns,
             (SELECT COUNT(*) FROM campaigns       WHERE creator_id = $1 AND is_active)::int AS "activeCampaigns",
             (SELECT COUNT(*) FROM scheduled_posts WHERE creator_id = $1)::int AS "scheduledPosts",
             (SELECT COUNT(*) FROM conversations   WHERE creator_id = $1)::int AS conversations,
             (SELECT COUNT(*) FROM interactions i  WHERE ${interactionsOwnedBy(1)})::int AS interactions,
             (SELECT COUNT(*) FROM messages m
                JOIN conversations cv ON cv.id = m.conversation_id
               WHERE cv.creator_id = $1)::int AS messages`,
        [tenantId]
    );

    return row ?? {
        campaigns: 0, activeCampaigns: 0, scheduledPosts: 0,
        conversations: 0, interactions: 0, messages: 0,
    };
}

/** Members of one tenant, for the detail view. `password_hash` is never selected. */
export async function getTenantMembers(
    tenantId: string
): Promise<Array<{ userId: string; email: string; role: string; membershipRole: string; isActive: boolean }>> {
    const rows = await queryRows<{
        user_id: string; email: string; role: string; membership_role: string; is_active: boolean;
    }>(
        `SELECT u.id AS user_id, u.email, u.role, m.role AS membership_role, u.is_active
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.creator_id = $1
          ORDER BY u.email`,
        [tenantId]
    );

    return rows.map((r) => ({
        userId: r.user_id,
        email: r.email,
        role: r.role,
        membershipRole: r.membership_role,
        isActive: r.is_active,
    }));
}
