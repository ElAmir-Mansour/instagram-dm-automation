/**
 * The daily run (MONTEUR.md §7), Run now, and Choose folder.
 *
 * The daily run needs no cron. `enqueueDueMonteurScan` runs at the top of every worker claim,
 * and queues a scan only when the latest `run_at` instant at or before now (today's, or
 * yesterday's while today's is still ahead) has no scan created at or after it. So:
 *   - a Mac asleep at 07:00 scans the next time it polls;
 *   - a worker that is off never piles up scans: nothing is queued while nobody claims, and at
 *     most one a day once it is back;
 *   - a Run now after 07:00 counts as today's run.
 * `run_at` is a wall-clock time in `schedule.timezone`, converted per day, so a timezone with
 * daylight saving keeps its local time through the change.
 */
import { pool } from '../../config/db.js';
import type { MonteurConfig, MonteurScanPayload, PickFolderPayload } from '../../db/rows.js';
import { log } from '../../utils/log.js';
import { type Exec, StudioError } from '../studio/common.js';
import { enqueueJob, findOpenJob, type StudioJobView } from '../studio/jobs.js';
import { getStudioSettings } from '../studio/settings.js';
import { zonedTimeToUtc, zoneOffsetMs } from '../studio/slots.js';

export const SCAN_EXTENSIONS: readonly string[] = ['.mp4', '.mov', '.m4v', '.mkv', '.webm'];
/** A file younger than this may still be copying into the folder. */
export const SCAN_MIN_AGE_S = 60;

/** The native dialog's title, in the tenant's language. */
export const FOLDER_PROMPTS: Record<'ar' | 'en', string> = {
    ar: 'اختر مجلد الفيديوهات اللي يراقبه المونتير',
    en: 'Choose the folder of videos for the Monteur',
};

/** `run_at` on the local day `offset` days from `instant`'s, in `timeZone`, as an instant. */
function runAtOn(instant: number, runAt: string, timeZone: string, offset: number): number {
    const local = new Date(instant + zoneOffsetMs(instant, timeZone));
    const [hour, minute] = runAt.split(':').map(Number);
    // Date.UTC inside normalises the day, so "day 0" is the last day of the month before.
    return zonedTimeToUtc(
        local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate() + offset, hour ?? 0, minute ?? 0, timeZone,
    );
}

/** The latest `run_at` instant at or before `now`: today's, or yesterday's if today's hasn't come. */
export function latestRunAt(now: number, runAt: string, timeZone: string): number {
    const today = runAtOn(now, runAt, timeZone, 0);
    return today <= now ? today : runAtOn(now, runAt, timeZone, -1);
}

/** The next `run_at` instant after `now`. */
export function nextRunAt(now: number, runAt: string, timeZone: string): number {
    const today = runAtOn(now, runAt, timeZone, 0);
    return today > now ? today : runAtOn(now, runAt, timeZone, 1);
}

/** Every content key the tenant has: the worker skips those files. */
async function knownKeys(exec: Exec, creatorId: string): Promise<string[]> {
    const { rows } = await exec.query<{ content_key: string }>(
        'SELECT content_key FROM monteur_sources WHERE creator_id = $1', [creatorId]
    );
    return rows.map((r) => r.content_key);
}

export function scanPayload(monteur: MonteurConfig, known: string[]): MonteurScanPayload {
    return {
        folder: monteur.folder!,
        limit: monteur.videos_per_run,
        known,
        extensions: [...SCAN_EXTENSIONS],
        min_age_s: SCAN_MIN_AGE_S,
    };
}

/**
 * Queue today's scan if it is due. Returns the job it queued, or null. Also null while a scan is
 * still open, however old: a worker that has not finished yesterday's does not need today's too.
 */
export async function enqueueDueMonteurScan(creatorId: string, now: number = Date.now()): Promise<StudioJobView | null> {
    const settings = await getStudioSettings(creatorId);
    const m = settings.monteur;
    if (!m.enabled || !m.folder) return null;
    const due = latestRunAt(now, m.run_at, settings.schedule.timezone);
    const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM studio_jobs
          WHERE creator_id = $1 AND kind = 'monteur_scan'
            AND (created_at >= $2 OR status IN ('pending', 'claimed'))
          LIMIT 1`,
        [creatorId, new Date(due)]
    );
    if (rows[0]) return null;
    const job = await enqueueJob(pool, creatorId, 'monteur_scan', scanPayload(m, await knownKeys(pool, creatorId)));
    log('info', 'monteur.daily_scan_queued', { creator_id: creatorId, job_id: job.id, due: new Date(due).toISOString() });
    return job;
}

/**
 * POST /monteur/run: a scan now, whether or not the Monteur is switched on. The open scan is
 * returned instead of a second one — unless it was queued for another folder, which a pending
 * one is failed for.
 */
export async function runMonteurNow(creatorId: string): Promise<StudioJobView> {
    const { monteur } = await getStudioSettings(creatorId);
    if (!monteur.folder) {
        throw new StudioError(409, 'Choose the Monteur\'s folder first: it is where the worker looks for new videos.');
    }
    const open = await findOpenJob(pool, creatorId, 'monteur_scan');
    if (open && (open.payload as Partial<MonteurScanPayload>).folder === monteur.folder) return open;
    if (open?.status === 'pending') {
        await pool.query(
            `UPDATE studio_jobs SET status = 'failed', error = $3, updated_at = NOW()
              WHERE id = $1 AND creator_id = $2 AND status = 'pending'`,
            [open.id, creatorId, 'Superseded: the Monteur\'s folder changed.']
        );
    }
    return enqueueJob(pool, creatorId, 'monteur_scan', scanPayload(monteur, await knownKeys(pool, creatorId)));
}

/** POST /monteur/pick-folder: the worker shows the native folder dialog. One at a time. */
export async function requestFolderPick(creatorId: string): Promise<StudioJobView> {
    const open = await findOpenJob(pool, creatorId, 'pick_folder');
    if (open) return open;
    const { voice } = await getStudioSettings(creatorId);
    const payload: PickFolderPayload = { prompt: FOLDER_PROMPTS[voice.language === 'ar' ? 'ar' : 'en'] };
    return enqueueJob(pool, creatorId, 'pick_folder', payload);
}
