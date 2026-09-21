/**
 * Send-rate protection.
 *
 * The previous version of this file was a single in-memory counter that was imported by
 * src/index.ts and never actually called — `canSend()` and `record()` had zero call sites,
 * so no rate protection existed at all. It was also structurally wrong for Vercel: each
 * warm lambda instance kept its own counter, so the real send rate was the limit multiplied
 * by however many instances happened to be running.
 *
 * This version counts in Postgres, per creator, so the number means something.
 *
 * Note these are two different kinds of limit and they are deliberately separate:
 *   - platform limits (Meta's ~200 automated DMs/hour) -> `checkSendQuota`
 *   - per-recipient courtesy cap (1 automated DM per user per 24h) -> `canDmRecipient`
 */
import { queryOne, queryRows } from '../db/query.js';
import { pool } from '../config/db.js';

/** Conservative buffer under Meta's ~200/hr automation ceiling. */
const DEFAULT_HOURLY_LIMIT = 180;

/**
 * The app-wide ceiling, shared by every tenant.
 *
 * Meta's app-level limit is `200 × daily active users` per hour and it is pooled across the
 * whole app: it does not scale with tenant count in any way the product controls. The
 * consequence is that one tenant with a viral reel can 429 every other tenant, and the victims
 * see "some DMs failed" with nothing indicating that another customer caused it.
 *
 * `META_APP_HOURLY_LIMIT` exists because the real number is a function of daily active users,
 * which only Meta knows. The default is deliberately generous relative to today's single
 * tenant (one tenant's 180 can never reach it) so that turning this on cannot throttle the
 * live account — it is a ceiling for when there are several tenants, not a second per-tenant
 * limit. Lower it once the app's real DAU is known.
 */
const DEFAULT_APP_HOURLY_LIMIT = 1_000;

export interface QuotaResult {
    allowed: boolean;
    count: number;
    limit: number;
}

export interface FairQuotaResult extends QuotaResult {
    /** Which ceiling refused the send. `null` when it was allowed. */
    blockedBy: 'creator' | 'app' | null;
    /** The app-wide pool's state, for the log line that explains a cross-tenant refusal. */
    app: QuotaResult;
}

function appHourlyLimit(): number {
    const configured = Number(process.env.META_APP_HOURLY_LIMIT);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_APP_HOURLY_LIMIT;
}

/**
 * Atomically increment the current hour's counter and report whether this send is allowed.
 *
 * Increment-then-check rather than check-then-increment: two concurrent invocations both
 * reading "179" and both sending is exactly the race this is meant to prevent.
 */
export async function checkSendQuota(
    creatorId: string,
    bucket: string = 'dm',
    limit: number = DEFAULT_HOURLY_LIMIT
): Promise<QuotaResult> {
    const row = await queryOne<{ count: number }>(
        `INSERT INTO rate_limit_counters (creator_id, bucket, window_start, count)
         VALUES ($1, $2, date_trunc('hour', NOW()), 1)
         ON CONFLICT (creator_id, bucket, window_start)
         DO UPDATE SET count = rate_limit_counters.count + 1
         RETURNING count`,
        [creatorId, bucket]
    );

    const count = row?.count ?? 0;
    return { allowed: count <= limit, count, limit };
}

/**
 * Increment the app-wide counter and report whether this send is allowed.
 *
 * Separate table rather than a sentinel row in `rate_limit_counters`: that table's primary key
 * includes `creator_id`, which is NOT NULL and carries a foreign key to `creators`, so an
 * app-wide row would have to be a fake creator. See migration v14.
 */
export async function checkAppSendQuota(
    bucket: string = 'dm',
    limit: number = appHourlyLimit()
): Promise<QuotaResult> {
    const row = await queryOne<{ count: number }>(
        `INSERT INTO app_rate_limit_counters (bucket, window_start, count)
         VALUES ($1, date_trunc('hour', NOW()), 1)
         ON CONFLICT (bucket, window_start)
         DO UPDATE SET count = app_rate_limit_counters.count + 1
         RETURNING count`,
        [bucket]
    );

    const count = row?.count ?? 0;
    return { allowed: count <= limit, count, limit };
}

/**
 * Both ceilings, in the order that costs least when the answer is no.
 *
 * The per-creator bucket is checked first because it is the one that protects Meta from any
 * single tenant, and the app-wide bucket second because it protects tenants from each other.
 * Both increment unconditionally — increment-then-check is what makes them race-free — so a
 * refusal by the creator bucket still consumes one unit of the app pool. That is the correct
 * conservative direction: overcounting the shared pool slows everyone down slightly, whereas
 * undercounting it is the 429 this exists to prevent.
 *
 * This is the only quota entry point the send paths should use.
 */
export async function checkFairSendQuota(
    creatorId: string,
    bucket: string = 'dm',
    limit: number = DEFAULT_HOURLY_LIMIT,
    /** Injected only so the precedence rules can be exercised without a database. */
    deps: {
        creatorQuota: typeof checkSendQuota;
        appQuota: typeof checkAppSendQuota;
    } = { creatorQuota: checkSendQuota, appQuota: checkAppSendQuota }
): Promise<FairQuotaResult> {
    const creator = await deps.creatorQuota(creatorId, bucket, limit);
    const app = await deps.appQuota(bucket);

    if (!creator.allowed) return { ...creator, blockedBy: 'creator', app };
    if (!app.allowed) return { ...app, blockedBy: 'app', app };
    return { ...creator, blockedBy: null, app };
}

/** Current count without incrementing — for dashboards and health checks. */
export async function getSendCount(creatorId: string, bucket: string = 'dm'): Promise<number> {
    const row = await queryOne<{ count: number }>(
        `SELECT count FROM rate_limit_counters
          WHERE creator_id = $1 AND bucket = $2 AND window_start = date_trunc('hour', NOW())`,
        [creatorId, bucket]
    );
    return row?.count ?? 0;
}

/**
 * One automated DM per recipient per 24 hours.
 *
 * Several 2026 write-ups describe this as a hard Meta rule for comment/story triggers. I
 * could not confirm it in Meta's primary documentation, so treat it as unverified — but it
 * costs nothing, it is trivially defensible if Meta ever asks, and it stops the app from
 * repeatedly DMing someone who comments the same keyword five times.
 */
export async function canDmRecipient(creatorId: string, recipientId: string): Promise<boolean> {
    const rows = await queryRows<{ exists: number }>(
        `SELECT 1 AS exists FROM dm_send_log
          WHERE creator_id = $1 AND recipient_id = $2 AND sent_at > NOW() - INTERVAL '24 hours'
          LIMIT 1`,
        [creatorId, recipientId]
    );
    return rows.length === 0;
}

export async function recordDmSent(creatorId: string, recipientId: string): Promise<void> {
    await pool.query(
        `INSERT INTO dm_send_log (creator_id, recipient_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [creatorId, recipientId]
    );
}

/** Drop counters and send-log rows older than 48h. Called from the publish cron. */
export async function pruneRateLimitData(): Promise<void> {
    await pool.query(`DELETE FROM rate_limit_counters WHERE window_start < NOW() - INTERVAL '48 hours'`);
    await pool.query(`DELETE FROM dm_send_log WHERE sent_at < NOW() - INTERVAL '48 hours'`);
    // v14's app-wide bucket, pruned on the same schedule. Left out, this table would be the
    // one place in the schema that grows forever by design.
    await pool.query(`DELETE FROM app_rate_limit_counters WHERE window_start < NOW() - INTERVAL '48 hours'`);
}
