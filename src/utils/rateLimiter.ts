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
import { pool } from '../config/db.js';

/** Conservative buffer under Meta's ~200/hr automation ceiling. */
const DEFAULT_HOURLY_LIMIT = 180;

export interface QuotaResult {
    allowed: boolean;
    count: number;
    limit: number;
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
    const res = await pool.query(
        `INSERT INTO rate_limit_counters (creator_id, bucket, window_start, count)
         VALUES ($1, $2, date_trunc('hour', NOW()), 1)
         ON CONFLICT (creator_id, bucket, window_start)
         DO UPDATE SET count = rate_limit_counters.count + 1
         RETURNING count`,
        [creatorId, bucket]
    );

    const count: number = res.rows[0]?.count ?? 0;
    return { allowed: count <= limit, count, limit };
}

/** Current count without incrementing — for dashboards and health checks. */
export async function getSendCount(creatorId: string, bucket: string = 'dm'): Promise<number> {
    const res = await pool.query(
        `SELECT count FROM rate_limit_counters
          WHERE creator_id = $1 AND bucket = $2 AND window_start = date_trunc('hour', NOW())`,
        [creatorId, bucket]
    );
    return res.rows[0]?.count ?? 0;
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
    const res = await pool.query(
        `SELECT 1 FROM dm_send_log
          WHERE creator_id = $1 AND recipient_id = $2 AND sent_at > NOW() - INTERVAL '24 hours'
          LIMIT 1`,
        [creatorId, recipientId]
    );
    return res.rows.length === 0;
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
}
