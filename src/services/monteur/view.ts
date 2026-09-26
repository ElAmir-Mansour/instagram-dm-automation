/**
 * What the dashboard's Monteur page reads (MONTEUR.md §5): `GET /api/studio/monteur` and the
 * shapes every Monteur route answers with. A source's transcript is never selected here.
 */
import { pool } from '../../config/db.js';
import type { ClipCopy, ClipDraftRow, MonteurConfig, MonteurSourceRow, StudioLessonRow } from '../../db/rows.js';
import { toIso } from '../health.js';
import { type Exec, StudioError, withTransaction } from '../studio/common.js';
import { enqueueJob } from '../studio/jobs.js';
import { getStudioSettings } from '../studio/settings.js';
import { nextFreeSlots } from '../studio/slots.js';
import { workerSummary } from '../studio/worker.js';
import { STALE_RUN_MS } from './analyst.js';
import { nextRunAt } from './daily.js';

export const MAX_SOURCES_SHOWN = 30;
export const MAX_CLIPS_SHOWN = 60;
/** The clips the page lists; a rejected clip is gone from it. */
export const LISTED_CLIP_STATUSES = ['review', 'rendering', 'failed', 'scheduled'] as const;
export const STALE_RUN_ERROR = 'This run never finished: the request was cut off.';

export interface SourceView {
    id: string;
    name: string;
    path: string;
    duration: number | null;
    status: MonteurSourceRow['status'];
    error: string | null;
    /** Clips cut from it, in any state. */
    clips: number;
    created_at: string | null;
    updated_at: string | null;
}

export interface ClipView {
    id: string;
    source_id: string;
    source_name: string;
    rank: number;
    status: ClipDraftRow['status'];
    start: number;
    end: number;
    duration: number;
    title: string;
    hook: string;
    why: string | null;
    score: number | null;
    copy: ClipCopy;
    video_url: string | null;
    cover_url: string | null;
    scheduled_time: string | null;
    error: string | null;
    created_at: string | null;
}

export interface LessonsView {
    lessons: { rule: string; evidence: string }[];
    summary: string | null;
    basis: { posts: number; from: string | null; to: string | null };
    created_at: string | null;
    model: string | null;
    status: StudioLessonRow['status'];
    error: string | null;
}

export interface MonteurView {
    settings: MonteurConfig;
    timezone: string;
    /** ISO; null when the Monteur is off or has no folder. */
    next_run: string | null;
    last_scan: { at: string; added: number; skipped: number; missing: boolean } | null;
    worker: { online: boolean; lastSeen: string | null; name: string | null };
    pending: { scan: boolean; folder_pick: boolean };
    /** What Approve would take now. */
    next_slot: string | null;
    sources: SourceView[];
    clips: ClipView[];
    lessons: LessonsView | null;
}

// ─── Presenters ─────────────────────────────────────────────────────────────────────────

export const SOURCE_VIEW_COLUMNS = `s.id, s.name, s.path, s.duration::float8 AS duration, s.status, s.error, s.created_at, s.updated_at,
    (SELECT COUNT(*)::int FROM clip_drafts c WHERE c.source_id = s.id) AS clips`;

export const CLIP_VIEW_COLUMNS = `c.id, c.source_id, s.name AS source_name, c.rank, c.status,
    c.start_s::float8 AS start_s, c.end_s::float8 AS end_s, c.title, c.hook, c.why, c.score::float8 AS score,
    c.copy, c.render, c.schedule, c.error, c.created_at`;

type SourceViewRow = Pick<MonteurSourceRow, 'id' | 'name' | 'path' | 'duration' | 'status' | 'error' | 'created_at' | 'updated_at'> & { clips: number };
type ClipViewRow = Pick<ClipDraftRow, 'id' | 'source_id' | 'rank' | 'status' | 'start_s' | 'end_s' | 'title' | 'hook' | 'why' | 'score' | 'copy' | 'render' | 'schedule' | 'error' | 'created_at'> & { source_name: string };

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round2 = (n: number): number => Math.round(n * 100) / 100;

export function presentSource(row: SourceViewRow): SourceView {
    return {
        id: row.id, name: row.name, path: row.path, duration: num(row.duration), status: row.status, error: row.error,
        clips: Number(row.clips) || 0, created_at: toIso(row.created_at), updated_at: toIso(row.updated_at),
    };
}

export function presentClip(row: ClipViewRow): ClipView {
    const start = num(row.start_s) ?? 0;
    const end = num(row.end_s) ?? 0;
    return {
        id: row.id, source_id: row.source_id, source_name: row.source_name, rank: row.rank, status: row.status,
        start, end, duration: num(row.render?.duration) ?? round2(end - start),
        title: row.title, hook: row.hook, why: row.why, score: num(row.score), copy: row.copy,
        video_url: row.render?.video_url ?? null, cover_url: row.render?.cover_url ?? null,
        scheduled_time: row.schedule?.scheduled_time ?? null, error: row.error, created_at: toIso(row.created_at),
    };
}

/** A `running` row older than 10 minutes was cut off: shown as failed, not rewritten. */
export function presentLessons(row: StudioLessonRow, now: number = Date.now()): LessonsView {
    const stale = row.status === 'running' && now - new Date(row.created_at).getTime() > STALE_RUN_MS;
    return {
        lessons: (row.lessons ?? []).map((l) => ({ rule: l.rule, evidence: l.evidence ?? '' })),
        summary: row.summary,
        basis: { posts: row.basis?.posts ?? 0, from: row.basis?.from ?? null, to: row.basis?.to ?? null },
        created_at: toIso(row.created_at),
        model: row.model,
        status: stale ? 'failed' : row.status,
        error: stale ? (row.error ?? STALE_RUN_ERROR) : row.error,
    };
}

export async function loadSourceView(exec: Exec, creatorId: string, sourceId: string): Promise<SourceView> {
    const { rows } = await exec.query<SourceViewRow>(
        `SELECT ${SOURCE_VIEW_COLUMNS} FROM monteur_sources s WHERE s.id = $1 AND s.creator_id = $2`, [sourceId, creatorId]
    );
    if (!rows[0]) throw new StudioError(404, 'No such source.');
    return presentSource(rows[0]);
}

export async function loadClipView(exec: Exec, creatorId: string, clipId: string): Promise<ClipView> {
    const { rows } = await exec.query<ClipViewRow>(
        `SELECT ${CLIP_VIEW_COLUMNS}
           FROM clip_drafts c JOIN monteur_sources s ON s.id = c.source_id
          WHERE c.id = $1 AND c.creator_id = $2`,
        [clipId, creatorId]
    );
    if (!rows[0]) throw new StudioError(404, 'No such clip.');
    return presentClip(rows[0]);
}

// ─── The page ───────────────────────────────────────────────────────────────────────────

/**
 * The lessons card: the latest `done` row — what the prompts use — or, before the first one has
 * finished, the latest attempt, so a first run's progress or failure shows.
 */
async function lessonsView(creatorId: string, now: number): Promise<LessonsView | null> {
    const { rows } = await pool.query<StudioLessonRow>(
        `SELECT * FROM studio_lessons
          WHERE creator_id = $1
          ORDER BY (status = 'done') DESC, created_at DESC
          LIMIT 1`,
        [creatorId]
    );
    return rows[0] ? presentLessons(rows[0], now) : null;
}

export async function getMonteurView(creatorId: string, now: number = Date.now()): Promise<MonteurView> {
    const settings = await getStudioSettings(creatorId);
    const m = settings.monteur;
    const timezone = settings.schedule.timezone;
    const [lastScan, open, worker, slots, sources, clips, lessons] = await Promise.all([
        pool.query<{ updated_at: Date; result: Record<string, unknown> | null }>(
            `SELECT updated_at, result FROM studio_jobs
              WHERE creator_id = $1 AND kind = 'monteur_scan' AND status = 'done'
              ORDER BY updated_at DESC
              LIMIT 1`,
            [creatorId]
        ),
        pool.query<{ kind: string }>(
            `SELECT DISTINCT kind FROM studio_jobs
              WHERE creator_id = $1 AND kind IN ('monteur_scan', 'pick_folder') AND status IN ('pending', 'claimed')`,
            [creatorId]
        ),
        workerSummary(creatorId, now),
        nextFreeSlots(creatorId, { timezone, slots: m.post_at }, 1, now),
        pool.query<SourceViewRow>(
            `SELECT ${SOURCE_VIEW_COLUMNS} FROM monteur_sources s
              WHERE s.creator_id = $1
              ORDER BY s.created_at DESC
              LIMIT ${MAX_SOURCES_SHOWN}`,
            [creatorId]
        ),
        pool.query<ClipViewRow>(
            `SELECT ${CLIP_VIEW_COLUMNS}
               FROM clip_drafts c JOIN monteur_sources s ON s.id = c.source_id
              WHERE c.creator_id = $1 AND c.status = ANY($2::text[])
              ORDER BY c.created_at DESC, c.rank
              LIMIT ${MAX_CLIPS_SHOWN}`,
            [creatorId, [...LISTED_CLIP_STATUSES]]
        ),
        lessonsView(creatorId, now),
    ]);
    const scan = lastScan.rows[0];
    const result = scan?.result ?? {};
    const kinds = new Set(open.rows.map((r) => r.kind));
    return {
        settings: m,
        timezone,
        next_run: m.enabled && m.folder ? new Date(nextRunAt(now, m.run_at, timezone)).toISOString() : null,
        last_scan: scan
            ? {
                at: toIso(scan.updated_at)!,
                added: Number(result.added) || 0,
                skipped: Number(result.skipped) || 0,
                missing: result.missing === true,
            }
            : null,
        worker,
        pending: { scan: kinds.has('monteur_scan'), folder_pick: kinds.has('pick_folder') },
        next_slot: slots[0] ?? null,
        sources: sources.rows.map(presentSource),
        clips: clips.rows.map(presentClip),
        lessons,
    };
}

// ─── Retry ──────────────────────────────────────────────────────────────────────────────

/**
 * POST /sources/:id/retry, for a source that failed or found no clips. Without words it is
 * transcribed again; with them it goes back to `transcribed` with its attempts reset, and the next
 * drain picks it. The row is locked first, so two presses queue one transcription.
 */
export async function retrySource(creatorId: string, sourceId: string): Promise<SourceView> {
    return withTransaction(async (client) => {
        const { rows } = await client.query<Pick<MonteurSourceRow, 'id' | 'status' | 'path'> & { has_words: boolean }>(
            `SELECT id, status, path, words IS NOT NULL AS has_words
               FROM monteur_sources WHERE id = $1 AND creator_id = $2 FOR UPDATE`,
            [sourceId, creatorId]
        );
        const source = rows[0];
        if (!source) throw new StudioError(404, 'No such source.');
        if (source.status !== 'failed' && source.status !== 'no_clips') {
            throw new StudioError(409, `This video is ${source.status.replace('_', ' ')}; only a failed one, or one with no clips, can be retried.`);
        }
        if (source.has_words) {
            await client.query(
                `UPDATE monteur_sources
                    SET status = 'transcribed', attempts = 0, claimed_at = NULL, error = NULL, updated_at = NOW()
                  WHERE id = $1`,
                [source.id]
            );
        } else {
            await client.query(
                `UPDATE monteur_sources SET status = 'transcribing', error = NULL, updated_at = NOW() WHERE id = $1`,
                [source.id]
            );
            const { rows: open } = await client.query<{ id: string }>(
                `SELECT id FROM studio_jobs
                  WHERE creator_id = $1 AND kind = 'monteur_transcribe' AND status IN ('pending', 'claimed')
                    AND payload->>'sourceId' = $2
                  LIMIT 1`,
                [creatorId, source.id]
            );
            if (!open[0]) {
                const { voice } = await getStudioSettings(creatorId, client);
                await enqueueJob(client, creatorId, 'monteur_transcribe', {
                    sourceId: source.id, path: source.path, language: voice.language === 'ar' ? 'ar' : 'en',
                });
            }
        }
        return loadSourceView(client, creatorId, source.id);
    });
}
