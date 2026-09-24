/**
 * The Studio queue (STUDIO.md §5): what the Mac worker claims, and what each result does to
 * the lessons and drafts it was for.
 *
 *   pending ─claim→ claimed ─complete→ done
 *                      │  └──fail──→ failed (and its lesson or draft goes failed too)
 *                      └─ no heartbeat for 15 min → claimable again, three claims at most
 *
 * This is not `src/jobs/` (v13). That queue is drained by this app and its jobs are Meta
 * events; these are claimed by a machine that may be off for days and stays alive only by
 * reporting progress. What the two share is the rule that a claim must be atomic: here it is
 * FOR UPDATE SKIP LOCKED, which Postgres allows because this query has no window function.
 *
 * Every function takes the worker's tenant (see worker.ts) and touches only that tenant's rows.
 */
import { pool } from '../../config/db.js';
import { queryCount, queryOne } from '../../db/query.js';
import type {
    CarouselDraftRow, DraftRender, LessonNotes, MomentKind, RenderCarouselPayload, StudioJobKind, StudioJobRow,
} from '../../db/rows.js';
import { log } from '../../utils/log.js';
import { uploadIdFromUrl } from '../storage.js';
import {
    type Exec, clipText, isFiniteNumber, isPlainObject, problemsError, StudioError, unique, UUID_PATTERN,
    withTransaction,
} from './common.js';

/** A claim whose heartbeat is older than this is presumed dead: the worker crashed or slept. */
export const STALE_CLAIM_MINUTES = 15;
/** Claims per job. A job that goes quiet three times is failing the worker, not waiting for it. */
export const MAX_ATTEMPTS = 3;
/** Bounds one index result's insert. The contract expects 12–30; a short intro may have fewer. */
export const MAX_MOMENTS = 100;
/** Bounds one scan result. The course is 34 lessons. */
export const MAX_SCANNED_LESSONS = 1000;
/** How many validation problems a refusal lists. The rest are the same mistake, repeated. */
const MAX_PROBLEMS = 20;

export const EXHAUSTED_ERROR =
    `The worker stopped reporting on this job ${MAX_ATTEMPTS} times. It may be crashing on it: check ~/Library/Logs/aicourse-studio-worker.log on the Mac.`;
const SUPERSEDED_ERROR = 'Superseded by a newer render of the same draft.';

export type StudioJobView = Pick<
    StudioJobRow,
    'id' | 'kind' | 'status' | 'payload' | 'progress' | 'attempts' | 'error' | 'claimed_at' | 'heartbeat_at' | 'created_at' | 'updated_at'
>;

const JOB_COLUMNS = 'id, kind, status, payload, progress, attempts, error, claimed_at, heartbeat_at, created_at, updated_at';

type LockedJob = Pick<StudioJobRow, 'id' | 'creator_id' | 'kind' | 'status' | 'payload'>;

// ─── Enqueue ────────────────────────────────────────────────────────────────────────────

export async function enqueueJob(
    exec: Exec, creatorId: string, kind: StudioJobKind, payload: object
): Promise<StudioJobView> {
    const { rows } = await exec.query<StudioJobView>(
        `INSERT INTO studio_jobs (creator_id, kind, payload)
         VALUES ($1, $2, $3::jsonb)
         RETURNING ${JOB_COLUMNS}`,
        [creatorId, kind, JSON.stringify(payload)]
    );
    if (!rows[0]) throw new Error('studio_jobs insert returned no row.');
    return rows[0];
}

/**
 * The unfinished job of this kind, if there is one, so pressing a button twice returns the job
 * already queued instead of making the Mac do the work twice. `lessonId` narrows it to one lesson.
 */
export async function findOpenJob(
    exec: Exec, creatorId: string, kind: StudioJobKind, lessonId?: string
): Promise<StudioJobView | null> {
    const { rows } = await exec.query<StudioJobView>(
        `SELECT ${JOB_COLUMNS} FROM studio_jobs
          WHERE creator_id = $1 AND kind = $2 AND status IN ('pending', 'claimed')
            AND ($3::text IS NULL OR payload->>'lessonId' = $3::text)
          ORDER BY created_at DESC
          LIMIT 1`,
        [creatorId, kind, lessonId ?? null]
    );
    return rows[0] ?? null;
}

/**
 * Queue a render of the draft as it is now, and mark it `rendering`.
 *
 * Renders still `pending` for the same draft are failed as superseded first: the Mac would
 * render each of them only for `applyRender` to drop every result but the last. One already
 * `claimed` is left to finish; its result is dropped when it arrives.
 */
export async function enqueueRender(
    exec: Exec, creatorId: string, payload: RenderCarouselPayload
): Promise<{ job: StudioJobView; draft: CarouselDraftRow | null }> {
    await exec.query(
        `UPDATE studio_jobs SET status = 'failed', error = $3, updated_at = NOW()
          WHERE creator_id = $1 AND kind = 'render_carousel' AND status = 'pending'
            AND payload->>'draftId' = $2`,
        [creatorId, payload.draftId, SUPERSEDED_ERROR]
    );
    const job = await enqueueJob(exec, creatorId, 'render_carousel', payload);
    const { rows } = await exec.query<CarouselDraftRow>(
        `UPDATE carousel_drafts SET status = 'rendering', error = NULL, updated_at = NOW()
          WHERE id = $1 AND creator_id = $2
      RETURNING *`,
        [payload.draftId, creatorId]
    );
    return { job, draft: rows[0] ?? null };
}

/** Stop queued renders of a draft that is going away. A claimed one's result is dropped on arrival. */
export async function cancelRenders(exec: Exec, creatorId: string, draftId: string, reason: string): Promise<void> {
    await exec.query(
        `UPDATE studio_jobs SET status = 'failed', error = $3, updated_at = NOW()
          WHERE creator_id = $1 AND kind = 'render_carousel' AND status = 'pending'
            AND payload->>'draftId' = $2`,
        [creatorId, draftId, reason]
    );
}

/** The newest render job of a draft, whatever its state: the only one whose result may land. */
export async function latestRenderJobId(exec: Exec, creatorId: string, draftId: string): Promise<string | null> {
    const { rows } = await exec.query<{ id: string }>(
        `SELECT id FROM studio_jobs
          WHERE creator_id = $1 AND kind = 'render_carousel' AND payload->>'draftId' = $2
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [creatorId, draftId]
    );
    return rows[0]?.id ?? null;
}

// ─── Claim ──────────────────────────────────────────────────────────────────────────────

/**
 * The oldest claimable job: pending, or claimed with a heartbeat older than 15 minutes and
 * fewer than three claims behind it.
 *
 * SKIP LOCKED makes two claimers split the work rather than queue behind each other's lock,
 * and the lock itself is what stops them both taking the same row: the UPDATE runs on the row
 * the CTE locked, so a second claimer never sees it at all.
 */
export const CLAIM_SQL = `
    WITH picked AS (
        SELECT id
          FROM studio_jobs
         WHERE creator_id = $1
           AND (status = 'pending'
                OR (status = 'claimed'
                    AND COALESCE(heartbeat_at, claimed_at, created_at) < NOW() - make_interval(mins => $2)
                    AND attempts < $3))
         ORDER BY created_at, id
         LIMIT 1
           FOR UPDATE SKIP LOCKED
    )
    UPDATE studio_jobs j
       SET status = 'claimed',
           attempts = j.attempts + 1,
           claimed_at = NOW(),
           heartbeat_at = NOW(),
           progress = NULL,
           updated_at = NOW()
      FROM picked
     WHERE j.id = picked.id
 RETURNING j.id, j.kind, j.payload, j.attempts`;

export async function claimJob(
    creatorId: string
): Promise<{ id: string; kind: StudioJobKind; payload: StudioJobRow['payload'] } | null> {
    await failExhaustedClaims(creatorId);
    const row = await queryOne<Pick<StudioJobRow, 'id' | 'kind' | 'payload' | 'attempts'>>(
        CLAIM_SQL, [creatorId, STALE_CLAIM_MINUTES, MAX_ATTEMPTS]
    );
    if (!row) return null;
    log('info', 'studio.job_claimed', { job_id: row.id, kind: row.kind, attempt: row.attempts });
    return { id: row.id, kind: row.kind, payload: row.payload };
}

/**
 * Fail the stale claims that have used their three attempts, lesson or draft included, so a
 * job that crashes the worker every time ends as a visible failure rather than a lesson stuck
 * on "indexing" forever. Runs before each claim, in its own transaction.
 */
export async function failExhaustedClaims(creatorId: string): Promise<number> {
    return withTransaction(async (client) => {
        const { rows } = await client.query<LockedJob>(
            `UPDATE studio_jobs
                SET status = 'failed', error = $4, progress = NULL, updated_at = NOW()
              WHERE creator_id = $1 AND status = 'claimed'
                AND COALESCE(heartbeat_at, claimed_at, created_at) < NOW() - make_interval(mins => $2)
                AND attempts >= $3
          RETURNING id, creator_id, kind, status, payload`,
            [creatorId, STALE_CLAIM_MINUTES, MAX_ATTEMPTS, EXHAUSTED_ERROR]
        );
        for (const job of rows) {
            log('warn', 'studio.job_exhausted', { job_id: job.id, kind: job.kind });
            await applyFailure(client, job, EXHAUSTED_ERROR);
        }
        return rows.length;
    });
}

// ─── Progress ───────────────────────────────────────────────────────────────────────────

/** Heartbeat, with an optional line for the dashboard. A call with no text keeps the last one. */
export async function reportProgress(creatorId: string, jobId: string, progress: string | null): Promise<void> {
    const moved = await queryCount(
        `UPDATE studio_jobs
            SET progress = COALESCE($3, progress), heartbeat_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND creator_id = $2 AND status = 'claimed'`,
        [jobId, creatorId, progress]
    );
    if (moved === 0) {
        // Tells the worker to stop: the job finished, failed, or was never its to report on.
        const job = await queryOne<{ status: string }>(
            'SELECT status FROM studio_jobs WHERE id = $1 AND creator_id = $2', [jobId, creatorId]
        );
        if (!job) throw new StudioError(404, 'No such job.');
        throw new StudioError(409, `This job is ${job.status}, not claimed.`);
    }
}

// ─── Complete ───────────────────────────────────────────────────────────────────────────

export type CompleteOutcome = 'applied' | 'dropped' | 'already_done';

/**
 * Apply a result and mark the job done, in one transaction with the job row locked, so two
 * deliveries of the same result (the worker retrying a timed-out call) apply it once.
 *
 * A result that does not validate is a 400 and changes nothing: the job stays claimed, the
 * worker reports the failure, and if it never does the claim goes stale like any other.
 */
export async function completeJob(creatorId: string, jobId: string, result: unknown): Promise<CompleteOutcome> {
    return withTransaction(async (client) => {
        const job = await lockJob(client, creatorId, jobId);
        if (job.status === 'done') return 'already_done';
        if (job.status !== 'claimed') {
            throw new StudioError(409, `This job is ${job.status}; only a claimed job can be completed.`);
        }

        let stored: unknown;
        let outcome: CompleteOutcome = 'applied';
        if (job.kind === 'scan_library') {
            stored = await applyScan(client, job, result);
        } else if (job.kind === 'index_lesson') {
            stored = await applyIndex(client, job, result);
        } else if (job.kind === 'render_carousel') {
            const applied = await applyRender(client, job, result);
            stored = applied.stored;
            outcome = applied.outcome;
        } else {
            throw new StudioError(409, `Unknown job kind "${String(job.kind)}".`);
        }

        await client.query(
            `UPDATE studio_jobs
                SET status = 'done', result = $2::jsonb, progress = NULL, error = NULL, updated_at = NOW()
              WHERE id = $1`,
            [job.id, JSON.stringify(stored)]
        );
        log('info', 'studio.job_completed', { job_id: job.id, kind: job.kind, outcome });
        return outcome;
    });
}

async function lockJob(exec: Exec, creatorId: string, jobId: string): Promise<LockedJob> {
    const { rows } = await exec.query<LockedJob>(
        `SELECT id, creator_id, kind, status, payload FROM studio_jobs
          WHERE id = $1 AND creator_id = $2
            FOR UPDATE`,
        [jobId, creatorId]
    );
    if (!rows[0]) throw new StudioError(404, 'No such job.');
    return rows[0];
}

function payloadId(job: LockedJob, key: 'lessonId' | 'draftId'): string | null {
    const value = isPlainObject(job.payload) ? (job.payload as Record<string, unknown>)[key] : undefined;
    return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

// ── scan_library ──

export interface ScannedLesson {
    lesson_no: string;
    section_no: number | null;
    section_title: string | null;
    title: string;
    video_path: string;
    duration_s: number | null;
}

function scannedLessonProblem(raw: unknown): string | null {
    if (!isPlainObject(raw)) return 'not an object';
    if (typeof raw.lesson_no !== 'string' || !raw.lesson_no.trim() || raw.lesson_no.length > 20) return 'lesson_no must be text like "1.2"';
    if (typeof raw.title !== 'string' || !raw.title.trim()) return 'title is missing';
    if (typeof raw.video_path !== 'string' || !raw.video_path.startsWith('/')) return 'video_path must be an absolute path';
    if (raw.section_no != null && !(Number.isInteger(raw.section_no) && (raw.section_no as number) >= 0)) return 'section_no must be a whole number';
    if (raw.section_title != null && typeof raw.section_title !== 'string') return 'section_title must be text';
    if (raw.duration_s != null && !(isFiniteNumber(raw.duration_s) && raw.duration_s >= 0)) return 'duration_s must be a number of seconds';
    return null;
}

/**
 * The lessons to upsert. An entry that does not validate is skipped and named, rather than
 * refusing the whole scan: one oddly named file must not keep the other 33 lessons off the
 * screen. The last entry for a path wins, because ON CONFLICT cannot touch a row twice in one
 * statement.
 */
export function parseScanResult(result: unknown): { lessons: ScannedLesson[]; skipped: string[] } {
    if (!isPlainObject(result) || !Array.isArray(result.lessons)) {
        throw new StudioError(400, 'A scan result is { lessons: [...] }.');
    }
    if (result.lessons.length > MAX_SCANNED_LESSONS) {
        throw new StudioError(400, `A scan result holds at most ${MAX_SCANNED_LESSONS} lessons.`);
    }
    const byPath = new Map<string, ScannedLesson>();
    const skipped: string[] = [];
    result.lessons.forEach((raw: unknown, i: number) => {
        const problem = scannedLessonProblem(raw);
        if (problem) {
            skipped.push(`lessons[${i}]: ${problem}`);
            return;
        }
        const r = raw as Record<string, unknown>;
        byPath.set(r.video_path as string, {
            lesson_no: (r.lesson_no as string).trim(),
            section_no: (r.section_no as number | null | undefined) ?? null,
            section_title: clipText(r.section_title, 300),
            title: (r.title as string).trim().slice(0, 300),
            video_path: r.video_path as string,
            duration_s: (r.duration_s as number | null | undefined) ?? null,
        });
    });
    return { lessons: [...byPath.values()], skipped };
}

/** Upsert by `video_path`. Never deletes: a file gone from the Mac keeps its notes here. */
async function applyScan(exec: Exec, job: LockedJob, result: unknown): Promise<unknown> {
    const { lessons, skipped } = parseScanResult(result);
    if (lessons.length) {
        await exec.query(
            // `$1::uuid`: a parameter only in an INSERT … SELECT list is not typed from the column.
            `INSERT INTO course_lessons (creator_id, lesson_no, section_no, section_title, title, video_path, duration_s)
             SELECT $1::uuid, x.lesson_no, x.section_no, x.section_title, x.title, x.video_path, x.duration_s
               FROM jsonb_to_recordset($2::jsonb)
                    AS x(lesson_no TEXT, section_no INT, section_title TEXT, title TEXT, video_path TEXT, duration_s NUMERIC)
             ON CONFLICT (creator_id, video_path) DO UPDATE
                SET lesson_no = EXCLUDED.lesson_no,
                    section_no = EXCLUDED.section_no,
                    section_title = EXCLUDED.section_title,
                    title = EXCLUDED.title,
                    duration_s = EXCLUDED.duration_s,
                    updated_at = NOW()`,
            [job.creator_id, JSON.stringify(lessons)]
        );
    }
    if (skipped.length) log('warn', 'studio.scan_entries_skipped', { job_id: job.id, skipped: skipped.length });
    return { lessons: lessons.length, skipped: skipped.slice(0, MAX_PROBLEMS) };
}

// ── index_lesson ──

export const MOMENT_KINDS: readonly MomentKind[] = ['slide', 'ui', 'result', 'code', 'prompt', 'other'];

export interface NewMoment {
    t: number;
    description: string;
    kind: MomentKind;
    clean: boolean;
    thumb_url: string | null;
}

function optionalT(value: unknown): { t?: number } {
    return isFiniteNumber(value) && value >= 0 ? { t: value } : {};
}

function nonEmpty(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '';
}

function parseNotes(raw: unknown, problems: string[]): LessonNotes | null {
    if (!isPlainObject(raw)) {
        problems.push('notes must be an object');
        return null;
    }
    if (!nonEmpty(raw.summary)) problems.push('notes.summary is missing');
    const list = (key: string): unknown[] => {
        const value = raw[key];
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value)) {
            problems.push(`notes.${key} must be a list`);
            return [];
        }
        return value;
    };
    const points = list('points').flatMap((p, i) => {
        if (isPlainObject(p) && nonEmpty(p.title) && typeof p.detail === 'string') {
            return [{ title: p.title.trim(), detail: p.detail.trim(), ...optionalT(p.t) }];
        }
        problems.push(`notes.points[${i}] needs a title and a detail`);
        return [];
    });
    const prompts = list('prompts').flatMap((p, i) => {
        if (isPlainObject(p) && nonEmpty(p.text)) return [{ text: p.text, ...optionalT(p.t) }];
        problems.push(`notes.prompts[${i}] needs its text`);
        return [];
    });
    const tools = list('tools').flatMap((t, i) => {
        if (nonEmpty(t)) return [t.trim()];
        problems.push(`notes.tools[${i}] must be a name`);
        return [];
    });
    const demos = list('demos').flatMap((d, i) => {
        if (isPlainObject(d) && nonEmpty(d.title) && typeof d.result === 'string') {
            return [{ title: d.title.trim(), result: d.result.trim(), ...optionalT(d.t) }];
        }
        problems.push(`notes.demos[${i}] needs a title and a result`);
        return [];
    });
    return { summary: String(raw.summary ?? '').trim(), points, prompts, tools, demos };
}

function parseMoment(raw: unknown, i: number, problems: string[]): NewMoment | null {
    if (!isPlainObject(raw)) {
        problems.push(`moments[${i}] must be an object`);
        return null;
    }
    const before = problems.length;
    if (!(isFiniteNumber(raw.t) && raw.t >= 0)) problems.push(`moments[${i}].t must be seconds into the video`);
    if (!nonEmpty(raw.description)) problems.push(`moments[${i}].description is missing`);
    if (!(MOMENT_KINDS as readonly unknown[]).includes(raw.kind)) {
        problems.push(`moments[${i}].kind must be one of ${MOMENT_KINDS.join(', ')}`);
    }
    if (raw.clean !== undefined && typeof raw.clean !== 'boolean') problems.push(`moments[${i}].clean must be true or false`);
    if (raw.thumb_url != null && typeof raw.thumb_url !== 'string') problems.push(`moments[${i}].thumb_url must be a URL`);
    if (problems.length > before) return null;
    return {
        t: raw.t as number,
        description: (raw.description as string).trim(),
        kind: raw.kind as MomentKind,
        clean: raw.clean !== false,
        thumb_url: clipText(raw.thumb_url, 1000),
    };
}

/** All or nothing: half a lesson's moments would read as the whole lesson. */
export function parseIndexResult(result: unknown): { notes: LessonNotes; moments: NewMoment[] } {
    if (!isPlainObject(result)) throw new StudioError(400, 'An index result is { notes, moments }.');
    const problems: string[] = [];
    const notes = parseNotes(result.notes, problems);
    let moments: NewMoment[] = [];
    if (!Array.isArray(result.moments)) {
        problems.push('moments must be a list');
    } else if (result.moments.length > MAX_MOMENTS) {
        problems.push(`at most ${MAX_MOMENTS} moments, not ${result.moments.length}`);
    } else {
        moments = result.moments.flatMap((m: unknown, i: number) => parseMoment(m, i, problems) ?? []);
    }
    if (problems.length || !notes) throw problemsError(problems.slice(0, MAX_PROBLEMS), 'the index result');
    return { notes, moments };
}

/** Replace the moments, set the notes, and mark the lesson indexed. */
async function applyIndex(exec: Exec, job: LockedJob, result: unknown): Promise<unknown> {
    const { notes, moments } = parseIndexResult(result);
    const lessonId = payloadId(job, 'lessonId');
    const { rows } = lessonId
        ? await exec.query<{ id: string }>(
            'SELECT id FROM course_lessons WHERE id = $1 AND creator_id = $2 FOR UPDATE', [lessonId, job.creator_id]
        )
        : { rows: [] };
    if (!lessonId || !rows[0]) return { moments: 0, dropped: 'lesson_missing' };

    await exec.query('DELETE FROM lesson_moments WHERE lesson_id = $1', [lessonId]);
    if (moments.length) {
        await exec.query(
            `INSERT INTO lesson_moments (lesson_id, t, description, kind, clean, thumb_url)
             SELECT $1::uuid, x.t, x.description, x.kind, x.clean, x.thumb_url
               FROM jsonb_to_recordset($2::jsonb)
                    AS x(t NUMERIC, description TEXT, kind TEXT, clean BOOLEAN, thumb_url TEXT)`,
            [lessonId, JSON.stringify(moments)]
        );
    }
    await exec.query(
        `UPDATE course_lessons
            SET notes = $2::jsonb, status = 'indexed', indexed_at = NOW(), error = NULL, updated_at = NOW()
          WHERE id = $1`,
        [lessonId, JSON.stringify(notes)]
    );
    return { moments: moments.length };
}

// ── render_carousel ──

/** Upload URLs in slide order, the same count for both formats and for the carousel. */
export function parseRenderResult(result: unknown, slideCount: number | null): { ig: string[]; tt: string[] } {
    if (!isPlainObject(result)) throw new StudioError(400, 'A render result is { ig: [...], tt: [...] }.');
    const problems: string[] = [];
    const read = (key: 'ig' | 'tt'): string[] => {
        const value = result[key];
        if (!Array.isArray(value) || value.length === 0) {
            problems.push(`${key} must be a list of upload URLs`);
            return [];
        }
        value.forEach((url: unknown, i: number) => {
            if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || !uploadIdFromUrl(url)) {
                problems.push(`${key}[${i}] is not one of this app's upload URLs`);
            }
        });
        if (slideCount !== null && value.length !== slideCount) {
            problems.push(`${key} has ${value.length} images for ${slideCount} slides`);
        }
        return value.filter((url): url is string => typeof url === 'string');
    };
    const ig = read('ig');
    const tt = read('tt');
    if (problems.length) throw problemsError(problems.slice(0, MAX_PROBLEMS), 'the render result');
    return { ig, tt };
}

/** Every URL must be an upload this tenant owns — a render pointing anywhere else would publish it. */
async function assertOwnUploads(exec: Exec, creatorId: string, urls: readonly string[]): Promise<void> {
    const ids = unique(urls.map((url) => uploadIdFromUrl(url)!));
    const { rows } = await exec.query<{ id: string }>(
        'SELECT id FROM media_uploads WHERE id = ANY($1::uuid[]) AND creator_id = $2', [ids, creatorId]
    );
    const found = new Set(rows.map((r) => String(r.id).toLowerCase()));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) {
        throw problemsError(missing.slice(0, MAX_PROBLEMS).map((id) => `upload ${id} does not exist`), 'the render result');
    }
}

/**
 * Delete these uploads, except any in `keep` and any a `scheduled_posts` row still names, in
 * any state — a row that already published may yet be edited and republished.
 */
export async function deleteUnreferencedUploads(
    exec: Exec, creatorId: string, urls: readonly (string | null | undefined)[], keep: ReadonlySet<string> = new Set()
): Promise<number> {
    const ids = unique(urls.flatMap((url) => {
        const id = typeof url === 'string' ? uploadIdFromUrl(url) : null;
        return id && !keep.has(id) ? [id] : [];
    }));
    if (ids.length === 0) return 0;
    const { rowCount } = await exec.query(
        `DELETE FROM media_uploads m
          WHERE m.id = ANY($2::uuid[])
            AND m.creator_id = $1
            AND NOT EXISTS (
                SELECT 1 FROM scheduled_posts s
                 WHERE s.media_url LIKE '%' || m.id::text || '%'
                    OR s.cover_url LIKE '%' || m.id::text || '%'
                    OR array_to_string(s.media_urls, ' ') LIKE '%' || m.id::text || '%'
            )`,
        [creatorId, ids]
    );
    return rowCount ?? 0;
}

/**
 * Land a render on its draft, or drop it.
 *
 * Dropped when it is not the draft's latest render job (an edit arrived while it rendered),
 * when the draft is already scheduled, or when it is gone. A dropped render's uploads are
 * deleted: nothing will ever name them. A landed one replaces the previous render, whose
 * uploads are deleted unless a scheduled post uses them.
 */
async function applyRender(
    exec: Exec, job: LockedJob, result: unknown
): Promise<{ outcome: CompleteOutcome; stored: unknown }> {
    const payload = isPlainObject(job.payload) ? (job.payload as Partial<RenderCarouselPayload>) : {};
    const slides = isPlainObject(payload.carousel) && Array.isArray(payload.carousel.slides) ? payload.carousel.slides.length : null;
    const render = parseRenderResult(result, slides);
    const urls = [...render.ig, ...render.tt];
    await assertOwnUploads(exec, job.creator_id, urls);

    const draftId = payloadId(job, 'draftId');
    const { rows } = draftId
        ? await exec.query<Pick<CarouselDraftRow, 'id' | 'status' | 'render'>>(
            'SELECT id, status, render FROM carousel_drafts WHERE id = $1 AND creator_id = $2 FOR UPDATE',
            [draftId, job.creator_id]
        )
        : { rows: [] };
    const draft = rows[0];
    const latest = draftId ? await latestRenderJobId(exec, job.creator_id, draftId) : null;

    const reason = !draft ? 'draft_missing' : draft.status === 'scheduled' ? 'draft_scheduled' : latest !== job.id ? 'superseded' : null;
    if (reason) {
        const deleted = await deleteUnreferencedUploads(exec, job.creator_id, urls);
        log('info', 'studio.render_dropped', { job_id: job.id, draft_id: draftId, reason, uploads_deleted: deleted });
        return { outcome: 'dropped', stored: { ...render, dropped: reason } };
    }

    const next: DraftRender = { ig: render.ig, tt: render.tt, rendered_at: new Date().toISOString(), job_id: job.id };
    await exec.query(
        `UPDATE carousel_drafts
            SET render = $2::jsonb, status = 'ready', error = NULL, updated_at = NOW()
          WHERE id = $1`,
        [draft!.id, JSON.stringify(next)]
    );
    const previous = draft!.render;
    if (previous) {
        const keep = new Set(urls.map((url) => uploadIdFromUrl(url)!));
        await deleteUnreferencedUploads(exec, job.creator_id, [...(previous.ig ?? []), ...(previous.tt ?? [])], keep);
    }
    return { outcome: 'applied', stored: render };
}

// ─── Fail ───────────────────────────────────────────────────────────────────────────────

/** The worker gave up. Terminal: the operator re-presses the button once the cause is fixed. */
export async function failJob(creatorId: string, jobId: string, error: string): Promise<void> {
    await withTransaction(async (client) => {
        const job = await lockJob(client, creatorId, jobId);
        if (job.status === 'failed') return;
        if (job.status !== 'claimed') {
            throw new StudioError(409, `This job is ${job.status}; only a claimed job can fail.`);
        }
        await client.query(
            `UPDATE studio_jobs SET status = 'failed', error = $2, progress = NULL, updated_at = NOW() WHERE id = $1`,
            [job.id, error]
        );
        await applyFailure(client, job, error);
        log('warn', 'studio.job_failed', { job_id: job.id, kind: job.kind });
    });
}

/**
 * The lesson or draft a failed job was for goes `failed` with the error. A render that is no
 * longer the draft's latest leaves the draft alone: the newer one is still on its way, and a
 * scheduled draft is past rendering.
 */
async function applyFailure(exec: Exec, job: LockedJob, error: string): Promise<void> {
    if (job.kind === 'index_lesson') {
        const lessonId = payloadId(job, 'lessonId');
        if (!lessonId) return;
        await exec.query(
            `UPDATE course_lessons SET status = 'failed', error = $3, updated_at = NOW()
              WHERE id = $1 AND creator_id = $2`,
            [lessonId, job.creator_id, error]
        );
    } else if (job.kind === 'render_carousel') {
        const draftId = payloadId(job, 'draftId');
        if (!draftId || (await latestRenderJobId(exec, job.creator_id, draftId)) !== job.id) return;
        await exec.query(
            `UPDATE carousel_drafts SET status = 'failed', error = $3, updated_at = NOW()
              WHERE id = $1 AND creator_id = $2 AND status <> 'scheduled'`,
            [draftId, job.creator_id, error]
        );
    }
}

/** Counts for the status card. */
export async function jobCounts(creatorId: string): Promise<{ pending: number; claimed: number }> {
    const { rows } = await pool.query<{ status: string; n: number }>(
        `SELECT status, COUNT(*)::int AS n FROM studio_jobs
          WHERE creator_id = $1 AND status IN ('pending', 'claimed')
          GROUP BY status`,
        [creatorId]
    );
    const count = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    return { pending: count('pending'), claimed: count('claimed') };
}
