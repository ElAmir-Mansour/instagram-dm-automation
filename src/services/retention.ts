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
import { queryCount, queryOne } from '../db/query.js';
import { APP_SETTING_KEYS, getSetting } from './appSettings.js';
import { getJobQueue } from '../jobs/queue.js';
import { log } from '../utils/log.js';
import { isMissingTable } from './health.js';
import { removeQueuedMediaObjects } from './storage.js';
import { pruneOnboardingData, type OnboardingPruneResult } from './onboardingRetention.js';

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
 * How long a click on a tracked link (`/r/:code`, migration v38) is kept: 180 days, the plan's window (docs/DM_SALES_PLAN.md §9). A click is a
 * time, a person-or-preview flag and a coarse device class, with no address and no user-agent, so this is housekeeping more than privacy: the
 * funnel looks back 30 days at most, and the table stops growing for ever. The LINKS stay as long as their conversation does, because a person
 * may tap a link in a DM months later and it must still go where it went. The cutoff is computed here and handed to the statement as a
 * parameter, so a click exactly 180 days old is KEPT and one a millisecond older goes.
 */
export const LINK_CLICK_RETENTION_DAYS = 180;

/** Rows deleted per statement, for the same reason `PRUNE_BATCH_SIZE` exists. */
export const LINK_CLICK_PRUNE_BATCH = 5_000;

/** `$1` the cutoff, `$2` the batch. `idx_link_clicks_clicked_at` makes the inner select a range scan. */
export const PRUNE_LINK_CLICKS_SQL = `DELETE FROM link_clicks
 WHERE id IN (SELECT id FROM link_clicks WHERE clicked_at < $1 ORDER BY clicked_at LIMIT $2)`;

/** A click is pruned only when it is STRICTLY older than this. */
export function linkClickCutoff(now: number = Date.now()): Date {
    return new Date(now - LINK_CLICK_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Delete link clicks past the window, in batches, until a batch comes back short or the pass limit is reached (the next daily run continues).
 * Never throws. A database without migration v38 has no `link_clicks`: that is "nothing to prune", not a failed sweep.
 */
export async function pruneLinkClicks(now: number = Date.now()): Promise<{ deleted: number }> {
    const cutoff = linkClickCutoff(now);
    let deleted = 0;
    try {
        for (let pass = 0; pass < MAX_SWEEP_PASSES; pass++) {
            const batch = await queryCount(PRUNE_LINK_CLICKS_SQL, [cutoff, LINK_CLICK_PRUNE_BATCH]);
            deleted += batch;
            if (batch < LINK_CLICK_PRUNE_BATCH) break;
        }
    } catch (err) {
        if (!isMissingTable(err, 'link_clicks')) log('error', 'retention.link_clicks_prune_failed', { message: (err as Error)?.message });
        return { deleted };
    }
    if (deleted > 0) {
        log('info', 'retention.link_clicks_pruned', { deleted, retention_days: LINK_CLICK_RETENTION_DAYS });
    }
    return { deleted };
}

/**
 * Media whose only remaining reference is a post that already went live.
 *
 * `media_uploads` is `BYTEA` in Postgres and **nothing has ever deleted from it**. It grows
 * monotonically: 40MB across 17 files as of 2026-09-21, of which 30MB belongs to posts that
 * are already PUBLISHED. Meta fetches the URL once, at publish time, and hosts its own copy
 * afterwards — so three quarters of that storage is a copy nobody reads, on a 500MB tier.
 *
 * Migration v23 moved new uploads to Supabase Storage, which relocates the bytes but does not
 * stop them accumulating, so this still matters. Deleting a row whose bytes are in Storage
 * queues its object (the v23 trigger), and `runRetentionSweep` removes queued objects after its
 * passes — so the row and the object both go, and a failed Storage call is retried next run.
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
 * The Monteur's (v24): `clip_drafts.render` — both videos and the cover of every reel that is
 * rendering (a re-render keeps the last one until the new one lands), in review (waiting for
 * the operator's Approve) or scheduled (its post fetches them). A rejected or failed reel's files
 * are not kept (MONTEUR.md §2).
 *
 * These tables arrive with migrations v21 and v24, so this statement fails until both are
 * applied. It fails safe: a failed prune deletes nothing and is logged as
 * `retention.media_prune_failed`.
 *
 * Opt-in, like `pruneRawPayloads`, and off by default: this is an irreversible delete of the
 * operator's own media, and it should be their decision rather than a surprise on upgrade.
 * Never throws — it runs in the same cron invocation as the publishes.
 */
/**
 * How the media prune runs: `days`, after which a file nothing names goes; `published`, whether a
 * file whose post is PUBLISHED (and that nothing else needs) goes at once.
 *
 * Settings → Media storage → "Delete files once posted" (`storage.cleanup_after_publish`) turns on
 * both, with the minimum window for unnamed files: a week covers a render or a composer upload
 * that has landed and is not yet named by the row it is for. Without it, `MEDIA_RETENTION_DAYS`
 * decides as it always did: age only.
 */
export type MediaCleanupPolicy =
    | { enabled: true; days: number; published: boolean; source: 'setting' | 'env' }
    | { enabled: false; reason: 'unset' | 'invalid' | 'too_short' };

export async function mediaCleanupPolicy(): Promise<MediaCleanupPolicy> {
    let on = false;
    try {
        on = (await getSetting(APP_SETTING_KEYS.mediaCleanup)) === 'true';
    } catch (err) {
        // The setting cannot be read: fall back to the environment, which deletes less.
        log('warn', 'retention.media_setting_unreadable', { message: (err as Error)?.message });
    }
    if (on) return { enabled: true, days: MIN_RETENTION_DAYS, published: true, source: 'setting' };
    const env = resolveRetention(process.env.MEDIA_RETENTION_DAYS);
    return env.enabled ? { enabled: true, days: env.days, published: false, source: 'env' } : env;
}

/** Where `m.id` appears in a scheduled post: its video or image, its cover, any carousel slide. */
const NAMED_BY_POST = `(
                                    s.media_url LIKE '%' || m.id::text || '%'
                                 OR s.cover_url LIKE '%' || m.id::text || '%'
                                 OR array_to_string(s.media_urls, ' ') LIKE '%' || m.id::text || '%'
                              )`;

/**
 * The files the prune may delete. `$1` is the window in days for a file nothing names; `$2`, when
 * true, lets a file go at once if a PUBLISHED post names it. Either way nothing that may still be
 * needed goes — every guard below is ANDed.
 *
 * An infographic (v31) keeps its GIF for as long as it exists: the GIF is posted by hand, to
 * LinkedIn and the rest, so no post ever names it. Its MP4 and cover are kept until its posting
 * time, as a reel's are; after that they go like any posted file. The portrait its brand shows is
 * kept while the settings name it, and (v33) while the Creator Profile names it, with the logo.
 */
const MEDIA_CANDIDATES_HEAD_SQL = `
                    SELECT m.id
                      FROM media_uploads m
                     WHERE (
                           m.created_at < NOW() - make_interval(days => $1)
                        OR ($2::boolean AND EXISTS (
                               SELECT 1 FROM scheduled_posts s
                                WHERE s.status = 'PUBLISHED' AND ${NAMED_BY_POST}
                           ))
                       )`;

/**
 * A customer's file (`is_private`, migration v51) is never a candidate here, whatever its age and whatever names it or not. It follows its
 * own rule, below (`pruneOrphanedPrivateMedia`): the posts' rules (a published post, a week unnamed) are about a post's media, and a
 * customer's file is named by a message, not a post. Without this line the age rule would delete a voice note 7 to 30 days old that a
 * message in the inbox still points at.
 */
const PUBLIC_ONLY_SQL = `
                       AND NOT m.is_private`;

const MEDIA_CANDIDATES_GUARDS_SQL = `
                       AND NOT EXISTS (
                           SELECT 1
                             FROM scheduled_posts s
                            WHERE s.status IN ('PENDING', 'PUBLISHING', 'PROCESSING', 'FAILED')
                              AND ${NAMED_BY_POST}
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
                       AND NOT EXISTS (
                           SELECT 1
                             FROM clip_drafts c
                            WHERE (c.status IN ('rendering', 'review')
                                   OR (c.status = 'scheduled' AND (c.schedule->>'scheduled_time')::timestamptz > NOW()))
                              AND (COALESCE(c.render->>'video_url', '') || ' ' || COALESCE(c.render->>'tiktok_video_url', '')
                                   || ' ' || COALESCE(c.render->>'cover_url', ''))
                                  LIKE '%' || m.id::text || '%'
                       )
                       AND NOT EXISTS (
                           SELECT 1
                             FROM infographics i
                            WHERE (COALESCE(i.render->>'gif_url', '')
                                   || CASE WHEN i.status <> 'scheduled' OR (i.schedule->>'scheduled_time')::timestamptz > NOW()
                                           THEN ' ' || COALESCE(i.render->>'mp4_url', '') || ' ' || COALESCE(i.render->>'cover_url', '')
                                           ELSE '' END)
                                  LIKE '%' || m.id::text || '%'
                       )
                       AND NOT EXISTS (
                           SELECT 1
                             FROM studio_settings ss
                            WHERE ss.infographic->>'photo_url' LIKE '%' || m.id::text || '%'
                       )`;

const MEDIA_CANDIDATES_BASE_SQL = MEDIA_CANDIDATES_HEAD_SQL + PUBLIC_ONLY_SQL + MEDIA_CANDIDATES_GUARDS_SQL;

/**
 * The portrait and logo a stored Creator Profile names (v33). The portrait is mirrored into
 * `studio_settings.infographic.photo_url`, which the guard above already keeps; this is the guard for the day
 * the profile is the only thing that names it, and for the logo, which no setting holds. It is the last guard,
 * so a database without the table can run the rest (`withProfileTable`).
 *
 * The offers are read whole (`offers` as text), because an offer's `sales.image_url` (the cover the owner picked for the DM
 * bot, docs/DM_SALES_PLAN.md §5) sits in a list, and a file a profile names must outlive the sweep. A match on an upload's
 * id anywhere in the offers is a reason to keep it: it can only make the sweep delete fewer files.
 *
 * Only the CURRENT profile is read. Media named solely by an old `creator_profile_versions` row is not protected: a
 * superseded portrait or logo goes with the rest once nothing current names it, so restoring an old version (there
 * is no such feature yet) would show a broken image. Keeping every version's files forever would keep every
 * replaced upload, which is what this sweep exists to stop.
 */
const KEPT_BY_PROFILE_SQL = `
                       AND NOT EXISTS (
                           SELECT 1
                             FROM creator_profiles cp
                            WHERE (COALESCE(cp.profile->'brand'->>'portrait_url', '') || ' ' || COALESCE(cp.profile->'brand'->>'logo_url', '')
                                   || ' ' || COALESCE((cp.profile->'offers')::text, ''))
                                  LIKE '%' || m.id::text || '%'
                       )`;

export const MEDIA_CANDIDATES_SQL = MEDIA_CANDIDATES_BASE_SQL + KEPT_BY_PROFILE_SQL;

/** The candidate query without the guards a database behind the code cannot run: no `creator_profiles` (v33), no `is_private` (v51). */
function candidatesSql(guards: { profile: boolean; publicOnly: boolean }): string {
    return MEDIA_CANDIDATES_HEAD_SQL
        + (guards.publicOnly ? PUBLIC_ONLY_SQL : '')
        + MEDIA_CANDIDATES_GUARDS_SQL
        + (guards.profile ? KEPT_BY_PROFILE_SQL : '');
}

/** Logged once per process: the daily sweep and the clean-up screen both come here. */
let profileTableWarned = false;

/** `undefined_column` for this column: a database that has not had the migration that adds it. */
function isMissingColumn(err: unknown, column: string): boolean {
    const e = err as { code?: unknown; message?: unknown } | null;
    return e?.code === '42703' && typeof e.message === 'string' && e.message.includes(column);
}

/**
 * Runs `run` with the candidate query. A database that has not had v33 applied yet has no `creator_profiles`, and
 * the query would fail whole, so the media sweep would stop until `npm run migrate` ran. With no table no profile
 * names a file, so the clause is vacuous and the query runs again without it: what it deletes is what it deleted
 * before the clause existed. The same for a database behind v51: with no `is_private` column no file is private, so the
 * "not private" line is vacuous and the query runs again without it. Any other failure, about any other table or column,
 * is still the caller's.
 */
async function withOptionalGuards<T>(run: (candidatesSql: string) => Promise<T>): Promise<T> {
    const guards = { profile: true, publicOnly: true };
    for (;;) {
        try {
            return await run(candidatesSql(guards));
        } catch (err) {
            if (guards.profile && isMissingTable(err, 'creator_profiles')) {
                guards.profile = false;
                if (!profileTableWarned) {
                    profileTableWarned = true;
                    log('warn', 'retention.profile_table_missing', { fix: 'npm run migrate (migration_v33_creator_profiles.sql)' });
                }
            } else if (guards.publicOnly && isMissingColumn(err, 'is_private')) {
                guards.publicOnly = false;
            } else {
                throw err;
            }
        }
    }
}

/** Test hook: forget that the missing-v33 warning was logged. */
export function resetProfileTableWarning(): void {
    profileTableWarned = false;
}

export type MediaPruneOutcome =
    | { deleted: number; skipped: false }
    /** Retention is off, or configured below the minimum. Nothing was attempted. */
    | { deleted: 0; skipped: true; reason: 'disabled' }
    /** It was attempted and the query failed. Materially different from `disabled`. */
    | { deleted: 0; skipped: true; reason: 'error' };

export async function pruneOrphanedMedia(policy?: MediaCleanupPolicy): Promise<MediaPruneOutcome> {
    const setting = policy ?? await mediaCleanupPolicy();

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
        const deleted = await withOptionalGuards((candidates) => queryCount(
            `DELETE FROM media_uploads
              WHERE id IN (${candidates}
                     LIMIT $3
              )`,
            [setting.days, setting.published, PRUNE_BATCH_SIZE]
        ));

        if (deleted > 0) {
            log('info', 'retention.media_pruned', {
                deleted,
                retention_days: setting.days,
                published_at_once: setting.published,
                more_likely: deleted === PRUNE_BATCH_SIZE,
            });
        }
        return { deleted, skipped: false };
    } catch (err) {
        log('error', 'retention.media_prune_failed', { message: (err as Error)?.message });
        return { deleted: 0, skipped: true, reason: 'error' };
    }
}

/**
 * How long a customer's file that NO message names is kept before it is deleted. 30 days, from when it was saved.
 *
 * A private upload (a WhatsApp voice note, photo or document, migration v51) is kept for as long as a message points at it
 * (`messages.media_upload_id`): the message is the reason it exists, the inbox shows it, and erasure deletes both together
 * (`eraseCustomerMedia`). A file that no message names is a download whose message never landed, or a message that was deleted
 * (the foreign key then clears its pointer): nothing will ever show it, and keeping a person's file with no owner is the thing
 * the privacy pages promise not to do. The window is generous, not tight: the message is written right after the download, so
 * 30 days only has to outlast a stuck job and a retry or two, and a file saved a minute ago is never a candidate.
 */
export const PRIVATE_MEDIA_ORPHAN_DAYS = 30;

/**
 * The DELETE of `pruneOrphanedPrivateMedia`. Every condition is ANDed: private, older than the window, and named by no message. Oldest first,
 * so a backlog converges in order.
 */
export const PRIVATE_ORPHANS_SQL = `
            DELETE FROM media_uploads
             WHERE id IN (
                   SELECT m.id
                     FROM media_uploads m
                    WHERE m.is_private
                      AND m.created_at < NOW() - make_interval(days => $1)
                      AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.media_upload_id = m.id)
                    ORDER BY m.created_at
                    LIMIT $2
             )`;

export type PrivateMediaPruneOutcome =
    | { deleted: number; skipped: false }
    /** The database is behind the code (no `is_private`, v51, or no `messages.media_upload_id`, v50): no customer file exists to prune. */
    | { deleted: 0; skipped: true; reason: 'unmigrated' }
    | { deleted: 0; skipped: true; reason: 'error' };

/**
 * Delete the customer files nothing names. Not behind `MEDIA_RETENTION_DAYS` or "Delete files once posted": those are about reclaiming the
 * space posts' media takes, and are off by default; this is about not keeping a private person's file with no reason to, and runs on every
 * sweep. Never throws (the sweep runs ahead of the scheduled posts in the same cron invocation). The deleted rows' Storage objects are
 * queued by the v23 trigger and removed from the PRIVATE bucket by the same sweep, right after.
 */
export async function pruneOrphanedPrivateMedia(): Promise<PrivateMediaPruneOutcome> {
    try {
        const deleted = await queryCount(PRIVATE_ORPHANS_SQL, [PRIVATE_MEDIA_ORPHAN_DAYS, PRUNE_BATCH_SIZE]);
        if (deleted > 0) {
            log('info', 'retention.private_media_pruned', { deleted, window_days: PRIVATE_MEDIA_ORPHAN_DAYS, more_likely: deleted === PRUNE_BATCH_SIZE });
        }
        return { deleted, skipped: false };
    } catch (err) {
        if (isMissingColumn(err, 'is_private') || isMissingColumn(err, 'media_upload_id')) return { deleted: 0, skipped: true, reason: 'unmigrated' };
        log('error', 'retention.private_media_prune_failed', { message: (err as Error)?.message });
        return { deleted: 0, skipped: true, reason: 'error' };
    }
}

/** The rule "Delete files once posted" applies, whatever is saved: what the button runs and previews. */
export const CLEANUP_NOW_POLICY: Extract<MediaCleanupPolicy, { enabled: true }> = { enabled: true, days: MIN_RETENTION_DAYS, published: true, source: 'setting' };

/** What a clean-up would remove now: the files and their bytes. */
export async function previewMediaCleanup(): Promise<{ files: number; bytes: number }> {
    const row = await withOptionalGuards((candidates) => queryOne<{ files: string; bytes: string | null }>(
        `SELECT count(*) AS files, COALESCE(sum(COALESCE(u.size_bytes, octet_length(u.data))), 0) AS bytes
           FROM media_uploads u WHERE u.id IN (${candidates})`,
        [CLEANUP_NOW_POLICY.days, true]
    ));
    return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
}

/**
 * Settings → Media storage → "Clean up now": the rule, applied at once rather than at the next
 * daily sweep, then the deleted rows' objects removed from Storage. Returns what went.
 */
export async function cleanUpMediaNow(): Promise<{ files: number; bytes: number; objectsRemoved: number }> {
    const before = await previewMediaCleanup();
    let files = 0;
    for (let pass = 0; pass < MAX_SWEEP_PASSES; pass++) {
        const out = await pruneOrphanedMedia(CLEANUP_NOW_POLICY);
        if (out.skipped) throw new Error('The clean-up query failed; nothing more was deleted. See the logs.');
        files += out.deleted;
        if (out.deleted < PRUNE_BATCH_SIZE) break;
    }
    let objectsRemoved = 0;
    for (let pass = 0; pass < MAX_SWEEP_PASSES; pass++) {
        const out = await removeQueuedMediaObjects();
        objectsRemoved += out.removed;
        if (!out.removed) break;
    }
    log('info', 'retention.media_cleanup_now', { files, objects_removed: objectsRemoved, bytes: before.bytes });
    return { files, bytes: files ? before.bytes : 0, objectsRemoved };
}

export interface RetentionSweepResult {
    rawPayloadsCleared: number;
    jobsDeleted: number;
    mediaDeleted: number;
    /** Objects removed from Supabase Storage because their rows were deleted, by this sweep or any other. */
    mediaObjectsRemoved: number;
    passes: number;
    /** True when a pass came back full, so there is more behind it than this run cleared. */
    moreRemaining: boolean;
    /** What was forgotten about onboarding (P31): old events, long-expired invites, the text drafts fetched. Once per sweep, not per pass. */
    onboarding: OnboardingPruneResult;
    /** Clicks on tracked links older than `LINK_CLICK_RETENTION_DAYS` (S7). Once per sweep, not per pass. */
    linkClicksDeleted: number;
    /** Customer files (private uploads) no message named for `PRIVATE_MEDIA_ORPHAN_DAYS`. Once per sweep, in batches. */
    privateMediaDeleted: number;
}

/** Injected only so the loop's termination rules can be exercised without a database. */
export interface RetentionSweepDeps {
    pruneRaw: typeof pruneRawPayloads;
    pruneJobs: typeof pruneCompletedJobs;
    pruneMedia: typeof pruneOrphanedMedia;
    removeObjects: typeof removeQueuedMediaObjects;
    /** Optional so a test of the loop's termination rules need not name it; the real sweep always has it (`DEFAULT_RETENTION_DEPS`). */
    pruneOnboarding?: typeof pruneOnboardingData;
    /** Optional for the same reason; the real sweep always has it (`DEFAULT_RETENTION_DEPS`). */
    pruneLinkClicks?: typeof pruneLinkClicks;
    /** Optional for the same reason; the real sweep always has it (`DEFAULT_RETENTION_DEPS`). */
    prunePrivateMedia?: typeof pruneOrphanedPrivateMedia;
}

export const DEFAULT_RETENTION_DEPS: RetentionSweepDeps = {
    pruneRaw: pruneRawPayloads,
    pruneJobs: pruneCompletedJobs,
    pruneMedia: pruneOrphanedMedia,
    removeObjects: removeQueuedMediaObjects,
    pruneOnboarding: pruneOnboardingData,
    pruneLinkClicks,
    prunePrivateMedia: pruneOrphanedPrivateMedia,
};

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
export async function runRetentionSweep(deps: RetentionSweepDeps = DEFAULT_RETENTION_DEPS): Promise<RetentionSweepResult> {
    const result: RetentionSweepResult = {
        rawPayloadsCleared: 0, jobsDeleted: 0, mediaDeleted: 0, mediaObjectsRemoved: 0, passes: 0, moreRemaining: false,
        onboarding: { eventsDeleted: 0, invitesDeleted: 0, draftSourcesCleared: 0, moreRemaining: false },
        linkClicksDeleted: 0, privateMediaDeleted: 0,
    };

    await sweepPasses(deps, result);

    // Customer files nothing names, before the object queue drains so their objects go in this same run. Regardless of the media retention
    // setting: it is a privacy rule, not storage housekeeping. Converges like the passes above, and never throws.
    if (deps.prunePrivateMedia) {
        for (let pass = 0; pass < MAX_SWEEP_PASSES; pass++) {
            const out = await deps.prunePrivateMedia();
            result.privateMediaDeleted += out.deleted;
            if (out.deleted < PRUNE_BATCH_SIZE) break;
            if (pass === MAX_SWEEP_PASSES - 1) result.moreRemaining = true;
        }
    }

    // After the passes, and whatever they found: the queue also holds objects whose rows the
    // Studio or a tenant deletion removed, and it must drain even with MEDIA_RETENTION_DAYS unset.
    const objects = await deps.removeObjects();
    result.mediaObjectsRemoved = objects.removed;

    // Onboarding's own housekeeping, once (P31). It cannot throw (`pruneOnboardingData` logs and returns zeros), and a database
    // without v34 has none of these tables, which it reads as "nothing to prune".
    if (deps.pruneOnboarding) result.onboarding = await deps.pruneOnboarding();

    // Tracked-link clicks (S7), once. It cannot throw (`pruneLinkClicks` logs and returns what it deleted), and a database without v38 reads as nothing.
    if (deps.pruneLinkClicks) result.linkClicksDeleted = (await deps.pruneLinkClicks()).deleted;
    return result;
}

async function sweepPasses(deps: RetentionSweepDeps, result: RetentionSweepResult): Promise<void> {
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
        if (!rawFull && !jobsFull && !mediaFull) return;

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
}
