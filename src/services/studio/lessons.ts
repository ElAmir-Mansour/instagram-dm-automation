/**
 * The course library (STUDIO.md §4): what the operator sees of it, and the scan and index jobs
 * that fill it in.
 */
import { pool } from '../../config/db.js';
import { queryRows } from '../../db/query.js';
import type { LessonRow, Moment, ScanLibraryPayload } from '../../db/rows.js';
import { StudioError, withTransaction } from './common.js';
import { enqueueJob, findOpenJob, type StudioJobView } from './jobs.js';
import { getStudioSettings } from './settings.js';

/** NUMERIC columns cast, or `pg` returns them as strings. */
export const LESSON_COLUMNS = `id, creator_id, lesson_no, section_no, section_title, title, video_path,
    duration_s::float8 AS duration_s, status, notes, indexed_at, error, created_at, updated_at`;
export const MOMENT_COLUMNS = 'id, lesson_id, t::float8 AS t, description, kind, clean, thumb_url';

/**
 * "1.2" before "1.10", and both before "G.1" and "I.1": numeric runs compare as numbers.
 * Done here rather than in SQL because Postgres has no natural sort without an ICU collation
 * the database may not have.
 */
export function compareLessonNo(a: string, b: string): number {
    return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

export type LessonListItem = Omit<LessonRow, 'notes'> & { summary: string | null; moments_count: number };

export async function listLessons(creatorId: string): Promise<LessonListItem[]> {
    const rows = await queryRows<LessonListItem>(
        `SELECT l.id, l.creator_id, l.lesson_no, l.section_no, l.section_title, l.title, l.video_path,
                l.duration_s::float8 AS duration_s, l.status, l.indexed_at, l.error, l.created_at, l.updated_at,
                l.notes->>'summary' AS summary,
                (SELECT COUNT(*)::int FROM lesson_moments m WHERE m.lesson_id = l.id) AS moments_count
           FROM course_lessons l
          WHERE l.creator_id = $1`,
        [creatorId]
    );
    return rows.sort((a, b) => compareLessonNo(a.lesson_no, b.lesson_no) || a.title.localeCompare(b.title));
}

export async function getLesson(creatorId: string, lessonId: string): Promise<{ lesson: LessonRow; moments: Moment[] }> {
    const [lesson] = await queryRows<LessonRow>(
        `SELECT ${LESSON_COLUMNS} FROM course_lessons WHERE id = $1 AND creator_id = $2`, [lessonId, creatorId]
    );
    if (!lesson) throw new StudioError(404, 'No such lesson.');
    const moments = await queryRows<Moment>(
        `SELECT ${MOMENT_COLUMNS} FROM lesson_moments WHERE lesson_id = $1 ORDER BY t, created_at`, [lessonId]
    );
    return { lesson, moments };
}

/**
 * Queue a scan of the tenant's library folder. A scan already queued for the same folder is
 * returned instead of a second one; a folder changed since then gets a fresh scan.
 */
export async function enqueueScan(creatorId: string): Promise<StudioJobView> {
    const { library } = await getStudioSettings(creatorId);
    if (!library.root) {
        throw new StudioError(400, 'Set your library folder first, in Studio settings: it is where the worker looks for your videos.');
    }
    const open = await findOpenJob(pool, creatorId, 'scan_library');
    if (open && (open.payload as ScanLibraryPayload).root === library.root) return open;
    const payload: ScanLibraryPayload = { root: library.root };
    return enqueueJob(pool, creatorId, 'scan_library', payload);
}

/**
 * Queue an index of one lesson and mark it `indexing`. The lesson row is locked first, so two
 * presses at once queue one job, and a job already queued for it is returned as is.
 */
export async function enqueueIndex(creatorId: string, lessonId: string): Promise<StudioJobView> {
    return withTransaction(async (client) => {
        const { rows } = await client.query<Pick<LessonRow, 'id' | 'video_path' | 'lesson_no' | 'title'>>(
            'SELECT id, video_path, lesson_no, title FROM course_lessons WHERE id = $1 AND creator_id = $2 FOR UPDATE',
            [lessonId, creatorId]
        );
        const lesson = rows[0];
        if (!lesson) throw new StudioError(404, 'No such lesson.');
        const job = await findOpenJob(client, creatorId, 'index_lesson', lesson.id)
            ?? await enqueueJob(client, creatorId, 'index_lesson', {
                lessonId: lesson.id, video_path: lesson.video_path, lesson_no: lesson.lesson_no, title: lesson.title,
            });
        await client.query(
            `UPDATE course_lessons SET status = 'indexing', error = NULL, updated_at = NOW() WHERE id = $1`, [lesson.id]
        );
        return job;
    });
}

/**
 * One index job per lesson that is not indexed and has none queued, in a single statement: the
 * lessons, the jobs and the status change cannot disagree about which lessons were queued.
 */
export async function indexMissing(creatorId: string): Promise<number> {
    const rows = await queryRows<{ id: string }>(
        `WITH missing AS (
             SELECT l.id, l.video_path, l.lesson_no, l.title
               FROM course_lessons l
              WHERE l.creator_id = $1
                AND l.status <> 'indexed'
                AND NOT EXISTS (
                    SELECT 1 FROM studio_jobs j
                     WHERE j.creator_id = $1 AND j.kind = 'index_lesson'
                       AND j.status IN ('pending', 'claimed')
                       AND j.payload->>'lessonId' = l.id::text
                )
         ),
         queued AS (
             INSERT INTO studio_jobs (creator_id, kind, payload)
             SELECT $1::uuid, 'index_lesson',
                    jsonb_build_object('lessonId', m.id, 'video_path', m.video_path,
                                       'lesson_no', m.lesson_no, 'title', m.title)
               FROM missing m
          RETURNING payload->>'lessonId' AS lesson_id
         )
         UPDATE course_lessons
            SET status = 'indexing', error = NULL, updated_at = NOW()
          WHERE creator_id = $1 AND id::text IN (SELECT lesson_id FROM queued)
      RETURNING id`,
        [creatorId]
    );
    return rows.length;
}

export async function lessonCounts(
    creatorId: string
): Promise<{ total: number; indexed: number; indexing: number; failed: number }> {
    const rows = await queryRows<{ status: string; n: number }>(
        'SELECT status, COUNT(*)::int AS n FROM course_lessons WHERE creator_id = $1 GROUP BY status', [creatorId]
    );
    const count = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    return {
        total: rows.reduce((sum, r) => sum + r.n, 0),
        indexed: count('indexed'),
        indexing: count('indexing'),
        failed: count('failed'),
    };
}
