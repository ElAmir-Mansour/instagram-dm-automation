/**
 * The daily visibility check (the owner asked on 2026-10-06). YouTube documents that an unaudited
 * project's uploads are restricted to private, yet this owner's went out public; nothing promises
 * it stays so. So once a day every published Short is asked about (videos.list, 50 a call, 1 quota
 * unit each), and one that is no longer what was asked for — made private, or gone — says so on its
 * row, which Posts shows beside "Open on YouTube", and in the Settings card's summary.
 *
 * The note lives in `error_log` behind VISIBILITY_PREFIX, so it can be replaced or cleared each day
 * without touching the upload's own notes (a thumbnail refusal, say). `status_checked_at` holds
 * when the row was last checked.
 */
import { queryCount, queryOne, queryRows } from '../db/query.js';
import type { ScheduledPostRow } from '../db/rows.js';
import { describeError, log } from '../utils/log.js';
import { youtubeUploadsPublic } from './appSettings.js';
import { listVideoStatuses, type VideoStatus } from './youtube.js';
import { getAccessToken } from './youtubeConnections.js';
import { VIDEO_ID_PREFIX } from './youtubePublish.js';

export const VISIBILITY_PREFIX = 'Visibility check';
/** How many published Shorts per tenant one day's check covers, newest first. */
const MAX_CHECKED = 500;

/** The day's sentence about one Short, or null when it is as expected. */
export function visibilityNote(status: VideoStatus | undefined, expectPublic: boolean, day: string): string | null {
    if (!status) return `${VISIBILITY_PREFIX} ${day}: YouTube no longer has this video (deleted or removed).`;
    if (status.uploadStatus === 'rejected' || status.uploadStatus === 'failed') {
        return `${VISIBILITY_PREFIX} ${day}: YouTube shows this upload as ${status.uploadStatus}.`;
    }
    if (expectPublic && status.privacy && status.privacy !== 'public') {
        return `${VISIBILITY_PREFIX} ${day}: YouTube now shows this Short as ${status.privacy} — make it public in YouTube Studio.`;
    }
    return null;
}

/** `error_log` with yesterday's visibility sentence swapped for today's (or removed). Null when nothing is left. */
export function mergeVisibilityNote(current: string | null, note: string | null): string | null {
    const kept = (current ?? '').split(/(?=Visibility check )/).map((s) => s.trim())
        .filter((s) => s && !s.startsWith(VISIBILITY_PREFIX)).join(' ');
    const next = [kept, note].filter(Boolean).join(' ');
    return next || null;
}

export interface VisibilityResult { tenants: number; checked: number; notPublic: number; missing: number; failed: number }

/** Run by the daily cron. Cannot throw: one tenant's failure is logged and the rest go on. */
export async function checkYouTubeVisibility(now: Date = new Date()): Promise<VisibilityResult> {
    const result: VisibilityResult = { tenants: 0, checked: 0, notPublic: 0, missing: 0, failed: 0 };
    const day = now.toISOString().slice(0, 10);
    let tenants: { creator_id: string }[] = [];
    try {
        tenants = await queryRows<{ creator_id: string }>(
            `SELECT creator_id FROM platform_connections WHERE platform = 'youtube' AND status = 'active'`
        );
    } catch (err) {
        log('error', 'youtube.visibility_check_failed', describeError(err));
        return result;
    }
    const expectPublic = await youtubeUploadsPublic().catch(() => false);
    for (const { creator_id } of tenants) {
        result.tenants++;
        try {
            const { accessToken } = await getAccessToken(creator_id);
            const rows = await queryRows<Pick<ScheduledPostRow, 'id' | 'published_post_id' | 'error_log'>>(
                `SELECT id, published_post_id, error_log FROM scheduled_posts
                  WHERE creator_id = $1 AND platform = 'youtube' AND status = 'PUBLISHED' AND published_post_id LIKE 'YT:%'
                  ORDER BY scheduled_time DESC LIMIT ${MAX_CHECKED}`,
                [creator_id]
            );
            for (let i = 0; i < rows.length; i += 50) {
                const batch = rows.slice(i, i + 50);
                const statuses = await listVideoStatuses(accessToken, batch.map((r) => r.published_post_id!.slice(VIDEO_ID_PREFIX.length)));
                for (const row of batch) {
                    const status = statuses.get(row.published_post_id!.slice(VIDEO_ID_PREFIX.length));
                    const note = visibilityNote(status, expectPublic, day);
                    if (!status) result.missing++;
                    else if (note) result.notPublic++;
                    result.checked++;
                    await queryCount(
                        `UPDATE scheduled_posts SET error_log = $2, status_checked_at = $3 WHERE id = $1`,
                        [row.id, mergeVisibilityNote(row.error_log, note), now]
                    );
                }
            }
        } catch (err) {
            result.failed++;
            log('warn', 'youtube.visibility_check_tenant_failed', { creator_id, ...describeError(err) });
        }
    }
    if (result.notPublic || result.missing) log('warn', 'youtube.visibility_changed', { ...result });
    return result;
}

/** The Settings card's line: how many published Shorts, how many are not as expected, and when last checked. */
export async function visibilitySummary(creatorId: string): Promise<{ total: number; flagged: number; checkedAt: string | null }> {
    const row = await queryOne<{ total: string; flagged: string; checked: Date | null }>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE error_log LIKE '%${VISIBILITY_PREFIX}%') AS flagged,
                max(status_checked_at) AS checked
           FROM scheduled_posts
          WHERE creator_id = $1 AND platform = 'youtube' AND status = 'PUBLISHED' AND published_post_id LIKE 'YT:%'`,
        [creatorId]
    );
    return { total: Number(row?.total ?? 0), flagged: Number(row?.flagged ?? 0), checkedAt: row?.checked ? new Date(row.checked).toISOString() : null };
}
