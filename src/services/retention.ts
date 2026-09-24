/**
 * Data retention.
 *
 * `messages.raw_payload` stores the entire Meta event, verbatim, forever. It exists for a
 * good reason — when a webhook shape changes or a handler mis-parses something, the original
 * event is the only way to find out what actually arrived — but "forever" was never a
 * decision anyone made. It is two separate problems:
 *
 *   Cost. Every inbound DM writes a JSONB blob several times the size of the columns beside
 *   it, into a database on a 500MB tier that already holds video in `media_uploads`.
 *
 *   Privacy. It is a permanent, unindexed record of what individual people wrote to this
 *   account, including their Meta user ids, long after they stopped interacting. Meta's
 *   Platform Terms require honouring deletion, and the app publishes a /data-deletion page
 *   promising exactly that — but a deletion request that clears `messages.text` and leaves
 *   `raw_payload` holding the same text has not deleted anything. This is the mechanism by
 *   which that promise is currently untrue.
 *
 * What this does NOT do: delete message rows. `text`, `direction` and `created_at` are what
 * the inbox renders and what `ai.ts` reads back as conversation history — losing them would
 * change the product. Only the redundant verbatim copy is cleared, and everything the
 * application actually reads has already been extracted into columns beside it.
 *
 * OPT-IN BY DESIGN. With `RAW_PAYLOAD_RETENTION_DAYS` unset this is a no-op. Nulling a column
 * is irreversible and this is a live account: the operator decides when, and the recommended
 * value (90) is in ARCHITECTURE.md rather than hardcoded here. Set it and the next cron run
 * begins clearing.
 */
import { queryCount } from '../db/query.js';
import { getJobQueue } from '../jobs/queue.js';
import { log } from '../utils/log.js';

/** Floor on the configurable window. Below this, debugging a live webhook issue is hopeless. */
export const MIN_RETENTION_DAYS = 7;

/**
 * How long a completed job is kept.
 *
 * Unlike `raw_payload` this is not opt-in, and the difference is deliberate: a `done` job is
 * work that finished, its outcome is already recorded in `interactions` / `messages`, and the
 * row itself is a verbatim Meta event held for no further purpose. A week is long enough to
 * answer "what did the queue do on Tuesday" and short enough that the table stops growing
 * without bound. `failed` rows are never touched — those are the ones an operator needs.
 */
export const DONE_JOB_RETENTION_DAYS = 7;

/** Rows deleted per pass, for the same reason `PRUNE_BATCH_SIZE` exists. */
export const JOB_PRUNE_BATCH_SIZE = 5_000;

/**
 * Passes one sweep may make before giving up until the next run.
 *
 * `pruneRawPayloads` clears one batch. That is correct for one statement and wrong for a
 * sweep: the only thing that calls it is the once-daily cron, so an account with 60,000
 * unpruned messages would take twelve days to converge — and for eleven of those the
 * `/data-deletion` promise stays untrue. Looping a bounded number of times converges in one
 * run for any realistic backlog while still being unable to monopolise the invocation.
 */
export const MAX_SWEEP_PASSES = 20;

/**
 * Rows cleared per run.
 *
 * Bounded because the first run against an account with months of history would otherwise be
 * a single UPDATE over the whole table, inside a cron invocation with a wall clock — and an
 * UPDATE that times out rolls back entirely, so it would never make progress. Chipping away
 * converges instead.
 */
export const PRUNE_BATCH_SIZE = 5_000;

export type RetentionSetting =
    | { enabled: false; reason: 'unset' | 'invalid' | 'too_short' }
    | { enabled: true; days: number };

/**
 * Interpret `RAW_PAYLOAD_RETENTION_DAYS`.
 *
 * Separated from the query so the policy — including the refusal to accept a dangerously
 * short window, and the refusal to guess at a typo — is testable without a database.
 * A misconfigured value disables pruning rather than falling back to a default: silently
 * deleting on a different schedule than the operator asked for is worse than not deleting.
 */
export function resolveRetention(raw: string | undefined): RetentionSetting {
    if (raw === undefined || raw.trim() === '') return { enabled: false, reason: 'unset' };

    const days = Number(raw);
    if (!Number.isFinite(days) || !Number.isInteger(days) || days <= 0) {
        return { enabled: false, reason: 'invalid' };
    }
    if (days < MIN_RETENTION_DAYS) return { enabled: false, reason: 'too_short' };

    return { enabled: true, days };
}

/**
 * Clear `raw_payload` on messages older than the configured window.
 *
 * Called from the publish cron. Never throws: a retention sweep must not be able to stop the
 * scheduled posts that run after it.
 */
export async function pruneRawPayloads(): Promise<{ cleared: number; skipped: boolean }> {
    const setting = resolveRetention(process.env.RAW_PAYLOAD_RETENTION_DAYS);

    if (!setting.enabled) {
        // Only worth a line when the operator tried to configure it and got it wrong —
        // "unset" is the default state and does not need saying on every cron run.
        if (setting.reason !== 'unset') {
            log('warn', 'retention.misconfigured', {
                reason: setting.reason,
                value: process.env.RAW_PAYLOAD_RETENTION_DAYS,
                minimum_days: MIN_RETENTION_DAYS,
            });
        }
        return { cleared: 0, skipped: true };
    }

    try {
        const cleared = await queryCount(
            `UPDATE messages
                SET raw_payload = NULL
              WHERE id IN (
                    SELECT id FROM messages
                     WHERE raw_payload IS NOT NULL
                       AND created_at < NOW() - make_interval(days => $1)
                     LIMIT $2
              )`,
            [setting.days, PRUNE_BATCH_SIZE]
        );

        if (cleared > 0) {
            log('info', 'retention.pruned', {
                cleared,
                retention_days: setting.days,
                // The operator needs to know another pass is due; a full batch almost
                // certainly means there is more behind it.
                more_likely: cleared === PRUNE_BATCH_SIZE,
            });
        }
        return { cleared, skipped: false };
    } catch (err) {
        log('error', 'retention.prune_failed', { message: (err as Error)?.message });
        return { cleared: 0, skipped: true };
    }
}

/** Delete completed jobs older than the retention window. Never throws. */
export async function pruneCompletedJobs(): Promise<{ deleted: number }> {
    try {
        const deleted = await getJobQueue().pruneCompleted(
            DONE_JOB_RETENTION_DAYS, JOB_PRUNE_BATCH_SIZE
        );
        if (deleted > 0) {
            log('info', 'retention.jobs_pruned', {
                deleted,
                retention_days: DONE_JOB_RETENTION_DAYS,
                more_likely: deleted === JOB_PRUNE_BATCH_SIZE,
            });
        }
        return { deleted };
    } catch (err) {
        log('error', 'retention.jobs_prune_failed', { message: (err as Error)?.message });
        return { deleted: 0 };
    }
}

/**
 * Media whose only remaining reference is a post that already went live.
 *
 * `media_uploads` is `BYTEA` in Postgres and **nothing has ever deleted from it**. It grows
 * monotonically: 40MB across 17 files as of 2026-09-21, of which 30MB belongs to posts that
 * are already PUBLISHED. Meta fetches the URL once, at publish time, and hosts its own copy
 * afterwards — so three quarters of that storage is a copy nobody reads, on a 500MB tier.
 *
 * ARCHITECTURE.md §7 Stage 3 proposes moving media to object storage. For a single-operator
 * deployment that is the wrong shape of fix: it adds an integration and a migration to solve
 * a problem better solved by deleting what is already dead. Reclaim rather than relocate.
 * The `MediaStore` seam stays, so Stage 3 remains available if the volume ever justifies it.
 *
 * ── What it will NOT delete, and why each matters ──
 *
 * A row is only eligible when **no** scheduled post in a non-final state references it, by
 * `media_url`, `cover_url` or any slide in `media_urls`:
 *
 *   - `PENDING` / `PUBLISHING` — the media is about to be fetched by Meta. Deleting it is a
 *     publish that fails with a broken URL.
 *   - `FAILED` — editing a failed post flips it back to `PENDING` and republishes, so its
 *     media has to survive. This is the non-obvious one: "failed" looks final and is not.
 *
 * `cover_url` is checked as well as `media_url` because it is a separate upload — it is the
 * whole reason a reel does not get a black frame-0 tile — and six posts currently have one.
 * Matching only `media_url` would delete covers that are still in use.
 *
 * `media_urls` (v20) for the same reason: `media_url` mirrors only a carousel's first image,
 * so slides 2..N would be deleted while the post waits to publish — and a TikTok photo post is
 * still fetching them while it is PROCESSING.
 *
 * The Studio's own references (v21), which no scheduled post names until a draft is scheduled:
 *
 *   - `carousel_drafts.render` — the `ig` and `tt` slides of every draft's current render. A
 *     `ready` draft is waiting for the operator to schedule it; deleting its slides would
 *     schedule a carousel of 404s. A superseded render's slides are not named here any more,
 *     and are deleted by the Studio itself when the new render lands.
 *   - `lesson_moments.thumb_url` — the thumbnails the shot picker shows. A re-index replaces
 *     the moments, so the old thumbnails fall out of this clause and are collected.
 *
 * Both tables arrive with migration v21, so this statement fails until it is applied. It fails
 * safe: a failed prune deletes nothing and is logged as `retention.media_prune_failed`.
 *
 * Opt-in, like `pruneRawPayloads`, and off by default: this is an irreversible delete of the
 * operator's own media, and it should be their decision rather than a surprise on upgrade.
 * Never throws — it runs in the same cron invocation as the publishes.
 */
export type MediaPruneOutcome =
    | { deleted: number; skipped: false }
    /** Retention is off, or configured below the minimum. Nothing was attempted. */
    | { deleted: 0; skipped: true; reason: 'disabled' }
    /** It was attempted and the query failed. Materially different from `disabled`. */
    | { deleted: 0; skipped: true; reason: 'error' };

export async function pruneOrphanedMedia(): Promise<MediaPruneOutcome> {
    const setting = resolveRetention(process.env.MEDIA_RETENTION_DAYS);

    if (!setting.enabled) {
        if (setting.reason !== 'unset') {
            log('warn', 'retention.media_misconfigured', {
                reason: setting.reason,
                value: process.env.MEDIA_RETENTION_DAYS,
                minimum_days: MIN_RETENTION_DAYS,
            });
        }
        return { deleted: 0, skipped: true, reason: 'disabled' };
    }

    try {
        const deleted = await queryCount(
            `DELETE FROM media_uploads
              WHERE id IN (
                    SELECT m.id
                      FROM media_uploads m
                     WHERE m.created_at < NOW() - make_interval(days => $1)
                       AND NOT EXISTS (
                           SELECT 1
                             FROM scheduled_posts s
                            WHERE s.status IN ('PENDING', 'PUBLISHING', 'PROCESSING', 'FAILED')
                              AND (
                                    s.media_url LIKE '%' || m.id::text || '%'
                                 OR s.cover_url LIKE '%' || m.id::text || '%'
                                 OR array_to_string(s.media_urls, ' ') LIKE '%' || m.id::text || '%'
                              )
                       )
                       AND NOT EXISTS (
                           SELECT 1
                             FROM carousel_drafts d
                            WHERE (COALESCE(d.render->>'ig', '') || ' ' || COALESCE(d.render->>'tt', ''))
                                  LIKE '%' || m.id::text || '%'
                       )
                       AND NOT EXISTS (
                           SELECT 1
                             FROM lesson_moments lm
                            WHERE lm.thumb_url LIKE '%' || m.id::text || '%'
                       )
                     LIMIT $2
              )`,
            [setting.days, PRUNE_BATCH_SIZE]
        );

        if (deleted > 0) {
            log('info', 'retention.media_pruned', {
                deleted,
                retention_days: setting.days,
                more_likely: deleted === PRUNE_BATCH_SIZE,
            });
        }
        return { deleted, skipped: false };
    } catch (err) {
        log('error', 'retention.media_prune_failed', { message: (err as Error)?.message });
        return { deleted: 0, skipped: true, reason: 'error' };
    }
}

export interface RetentionSweepResult {
    rawPayloadsCleared: number;
    jobsDeleted: number;
    mediaDeleted: number;
    passes: number;
    /** True when a pass came back full, so there is more behind it than this run cleared. */
    moreRemaining: boolean;
}

/** Injected only so the loop's termination rules can be exercised without a database. */
export interface RetentionSweepDeps {
    pruneRaw: typeof pruneRawPayloads;
    pruneJobs: typeof pruneCompletedJobs;
    pruneMedia: typeof pruneOrphanedMedia;
}

/**
 * The whole retention story, in one call, converging rather than chipping.
 *
 * This is what the cron invokes. It keeps going while each pass comes back full, because a
 * full batch means the backlog is larger than one batch and stopping there means waiting a
 * whole day to make the next 5,000 rows of progress.
 *
 * Never throws: it runs ahead of the scheduled posts in the same cron invocation, and a
 * retention sweep must not be able to stop a publish.
 */
export async function runRetentionSweep(
    deps: RetentionSweepDeps = {
        pruneRaw: pruneRawPayloads,
        pruneJobs: pruneCompletedJobs,
        pruneMedia: pruneOrphanedMedia,
    }
): Promise<RetentionSweepResult> {
    const result: RetentionSweepResult = {
        rawPayloadsCleared: 0, jobsDeleted: 0, mediaDeleted: 0, passes: 0, moreRemaining: false,
    };

    for (let pass = 0; pass < MAX_SWEEP_PASSES; pass++) {
        result.passes = pass + 1;

        const raw = await deps.pruneRaw();
        const jobs = await deps.pruneJobs();
        const media = await deps.pruneMedia();
        result.rawPayloadsCleared += raw.cleared;
        result.jobsDeleted += jobs.deleted;
        result.mediaDeleted += media.deleted;

        const rawFull = raw.cleared === PRUNE_BATCH_SIZE;
        const jobsFull = jobs.deleted === JOB_PRUNE_BATCH_SIZE;
        const mediaFull = media.deleted === PRUNE_BATCH_SIZE;

        // Nothing moved: every sweep is caught up, or switched off and finding nothing.
        // Either way another identical pass would do nothing.
        if (!rawFull && !jobsFull && !mediaFull) return result;

        if (pass === MAX_SWEEP_PASSES - 1) {
            result.moreRemaining = true;
            log('warn', 'retention.sweep_incomplete', {
                passes: result.passes,
                raw_payloads_cleared: result.rawPayloadsCleared,
                jobs_deleted: result.jobsDeleted,
                media_deleted: result.mediaDeleted,
            });
        }
    }

    return result;
}
