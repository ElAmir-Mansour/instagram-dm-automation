/**
 * The daily run (MONTEUR.md §7), Run now, and Choose folder.
 *
 * A run takes its videos from `monteur.source`: new files in the folder, or the course library's
 * next lessons with no source yet (`course_lessons`, in lesson order). Either way it is one
 * `monteur_scan`, and the result is applied the same way.
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
import {
    enqueueJob, findOpenJob, PICK_FOLDER_EXPIRED_ERROR, PICK_FOLDER_TTL_MINUTES, type StudioJobView,
} from '../studio/jobs.js';
import { compareLessonNo } from '../studio/lessons.js';
import { getMonteurSettings, getStudioSettings } from '../studio/settings.js';
import { zonedTimeToUtc, zoneOffsetMs } from '../studio/slots.js';

export const SCAN_EXTENSIONS: readonly string[] = ['.mp4', '.mov', '.m4v', '.mkv', '.webm'];
/** A file younger than this may still be copying into the folder. */
export const SCAN_MIN_AGE_S = 60;
/**
 * Course mode sends this many lessons past `videos_per_run`. A lesson the worker already knows by
 * its content (the same video once taken from a folder, under another path) is skipped, has no
 * source at its own path, and would otherwise be first in line every day, taking the run's place.
 */
export const COURSE_LOOKAHEAD = 10;

/** The lessons with no source at their path. Sorted in code: Postgres has no natural sort (lessons.ts). */
export const COURSE_LESSONS_SQL = `SELECT l.video_path, l.lesson_no, l.title FROM course_lessons l
     WHERE l.creator_id = $1
       AND NOT EXISTS (
           SELECT 1 FROM monteur_sources s WHERE s.creator_id = l.creator_id AND s.path = l.video_path
       )`;

export const NO_LESSONS_LEFT_ERROR = 'Every lesson in the course library already has its reels, or the library is empty: scan it in Studio → Library first.';

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

/** The first `n` lessons of the course library that no source was taken from, in lesson order. */
export async function nextCourseLessons(exec: Exec, creatorId: string, n: number): Promise<string[]> {
    const { rows } = await exec.query<{ video_path: string; lesson_no: string; title: string }>(COURSE_LESSONS_SQL, [creatorId]);
    return rows
        .sort((a, b) => compareLessonNo(a.lesson_no, b.lesson_no) || a.title.localeCompare(b.title))
        .slice(0, n)
        .map((r) => r.video_path);
}

/** The scan the settings ask for now, or null in course mode with no lesson left to take. */
async function scanFor(exec: Exec, creatorId: string, m: MonteurConfig): Promise<MonteurScanPayload | null> {
    if (m.source !== 'course') return scanPayload(m, await knownKeys(exec, creatorId));
    const files = await nextCourseLessons(exec, creatorId, m.videos_per_run + COURSE_LOOKAHEAD);
    if (!files.length) return null;
    return { ...scanPayload(m, await knownKeys(exec, creatorId)), folder: null, files };
}

/** Whether an open scan is the one the settings would queue now: of the course, or of this folder. */
function scanMatches(payload: unknown, m: MonteurConfig): boolean {
    const p = (payload && typeof payload === 'object' ? payload : {}) as Partial<MonteurScanPayload>;
    return m.source === 'course' ? Array.isArray(p.files) : !Array.isArray(p.files) && p.folder === m.folder;
}

/**
 * Queue today's scan if it is due. Returns the job it queued, or null. Also null while a scan is
 * still open, however old: a worker that has not finished yesterday's does not need today's too.
 *
 * Only a scan that finished, of the source set now, counts as today's run: one that failed, was
 * cancelled, or scanned another folder — or the folder, for a course run — leaves today still to
 * do. A course run with no lesson left queues nothing.
 */
export async function enqueueDueMonteurScan(creatorId: string, now: number = Date.now()): Promise<StudioJobView | null> {
    const { monteur: m, timezone } = await getMonteurSettings(creatorId);
    const course = m.source === 'course';
    if (!m.enabled || (!course && !m.folder)) return null;
    const due = latestRunAt(now, m.run_at, timezone);
    // $3 is the folder, or null for a course run: a course scan is the one that carries `files`.
    const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM studio_jobs
          WHERE creator_id = $1 AND kind = 'monteur_scan'
            AND (status IN ('pending', 'claimed')
                 OR (status = 'done' AND created_at >= $2
                     AND (($3::text IS NULL AND payload->'files' IS NOT NULL) OR payload->>'folder' = $3)))
          LIMIT 1`,
        [creatorId, new Date(due), course ? null : m.folder]
    );
    if (rows[0]) return null;
    const payload = await scanFor(pool, creatorId, m);
    if (!payload) return null;
    const job = await enqueueJob(pool, creatorId, 'monteur_scan', payload);
    log('info', 'monteur.daily_scan_queued', { creator_id: creatorId, job_id: job.id, due: new Date(due).toISOString() });
    return job;
}

/**
 * POST /monteur/run: a scan now, whether or not the Monteur is switched on. The open scan is
 * returned instead of a second one — unless it was queued for another folder or source, which a
 * pending one is failed for. 409 in folder mode with no folder, and in course mode with no lesson
 * left to take.
 */
export async function runMonteurNow(creatorId: string): Promise<StudioJobView> {
    const { monteur } = await getMonteurSettings(creatorId);
    if (monteur.source !== 'course' && !monteur.folder) {
        throw new StudioError(409, 'Choose the Monteur\'s folder first: it is where the worker looks for new videos.');
    }
    const open = await findOpenJob(pool, creatorId, 'monteur_scan');
    if (open && scanMatches(open.payload, monteur)) return open;
    const payload = await scanFor(pool, creatorId, monteur);
    if (!payload) throw new StudioError(409, NO_LESSONS_LEFT_ERROR);
    if (open?.status === 'pending') {
        await pool.query(
            `UPDATE studio_jobs SET status = 'failed', error = $3, updated_at = NOW()
              WHERE id = $1 AND creator_id = $2 AND status = 'pending'`,
            [open.id, creatorId, monteur.source === 'course' ? 'Superseded: the Monteur\'s source changed.' : 'Superseded: the Monteur\'s folder changed.']
        );
    }
    return enqueueJob(pool, creatorId, 'monteur_scan', payload);
}

/**
 * POST /monteur/pick-folder: the worker shows the native folder dialog. One at a time — but one
 * still waiting past its 10 minutes is expired and replaced: the claim would fail it anyway,
 * rather than pop a dialog up when nobody is at the Mac.
 */
export async function requestFolderPick(creatorId: string, now: number = Date.now()): Promise<StudioJobView> {
    const open = await findOpenJob(pool, creatorId, 'pick_folder');
    const stale = open?.status === 'pending' && now - new Date(open.created_at).getTime() > PICK_FOLDER_TTL_MINUTES * 60_000;
    if (open && !stale) return open;
    if (open && stale) {
        await pool.query(
            `UPDATE studio_jobs SET status = 'failed', error = $3, updated_at = NOW()
              WHERE id = $1 AND creator_id = $2 AND status = 'pending'`,
            [open.id, creatorId, PICK_FOLDER_EXPIRED_ERROR]
        );
    }
    const { voice } = await getStudioSettings(creatorId);
    const payload: PickFolderPayload = { prompt: FOLDER_PROMPTS[voice.language === 'ar' ? 'ar' : 'en'] };
    return enqueueJob(pool, creatorId, 'pick_folder', payload);
}
