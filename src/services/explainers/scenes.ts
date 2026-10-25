/**
 * The pictures of an explainer, seen from outside: the owner's actions on one scene, the character candidates, and the Mac's drawing step. The drawing itself
 * is pictures/draw.ts, candidates.ts and allowance.ts (the pictures service); this file decides WHEN each may be called and what the explainer does about
 * the answer, which is the status machine's business and not the drawing's:
 *
 *   drawOneScene    POST /explainers/:id/scenes/:position/draw `{ note? }`: draw or redraw one scene now, synchronously, with the owner's note. Answers `{ scene, allowance }`.
 *   pickOneScene    POST /explainers/:id/scenes/:position/pick `{ index }`: go back to one of the scene's earlier pictures. Answers `{ scene }`.
 *   drawNextStep    POST /api/studio/worker/explainers/:id/draw-next `{ job_id }`: ONE step of the unattended drawing, for the Mac's `explainer_draw` job. When nothing is
 *                   left to draw, the explainer moves to `review`.
 *   characterCandidates   POST /explainers/characters/candidates `{ description }`: four pictures to choose a character's reference from.
 *   currentAllowance      GET /explainers/allowance: today's free allowance, or null when no image provider is set up.
 *
 * WHEN. The owner draws, redraws and picks by hand once the narration is voiced and until it is posted: `drawing` (the loop may be running or waiting), `review`,
 * `ready` and `scheduled` (data-model §5: "Editing labels/pictures in `review`, `ready` or `scheduled` never changes status"), and `failed` when it was the drawing
 * that failed, which is where the owner fixes a scene by hand before pressing Retry. Not before (`writing`, `draft`, `voicing`: there is no audio to time the
 * scenes against and no approved script, and the allowance is not for pictures of a script that may still change), and not while `rendering`: the render has
 * already been handed its pictures. Every other state is 409 `EXPLAINER_BAD_STATE`, with the status and what was asked.
 *
 * THE LOOP'S STEP is refused (409 `EXPLAINER_BAD_STATE`) unless the `job_id` it sends is the explainer's own current job, that job is an `explainer_draw`, and a worker
 * has claimed it: a stale loop, another explainer's job, a job nobody started, or a finished one cannot spend the allowance. The check reads; it holds no lock across
 * the drawing, which is a network call (nothing here ever does). `drawNext` itself never moves the status and never looks at the job: both are this file's.
 * What it answers is what the worker's loop reads: `drawn`, `done`, `paused`, `failed`.
 *
 *   done     the explainer moves from `drawing` to `review`, in one transaction that re-checks it is still `drawing` and still this job's. The job stays the explainer's
 *            until the worker completes it (`applyDraw`'s `done` clears it): the move is the one that matters, and it is the same move if the job ends first.
 *   drawn    a pause note from an earlier round (`draw_paused_until`, the "waiting for the allowance" text) is cleared: drawing resumed, and the screen must not
 *            say it is waiting. One statement that matches nothing on every other step.
 *   paused   nothing is written here. The worker completes the job with `{ state: 'paused', until }` and `applyDraw` queues the next round for that time.
 *   failed   nothing is written here either: the scene carries its own reason, and the worker decides when the failures are too many (`applyDraw`).
 *
 * The pictures service is reached through `setPictureDeps`, so a test can answer without a provider; the real functions are the default.
 */
import { pool } from '../../config/db.js';
import type { ExplainerRow } from '../../db/rows.js';
import { log } from '../../utils/log.js';
import { isPlainObject, StudioError, UUID_PATTERN, withTransaction } from '../studio/common.js';
import { ExplainerError } from './errors.js';
import { explainerIdOf, presentScene, type SceneView } from './explainers.js';
import { allowanceStatus, type AllowanceStatus } from './pictures/allowance.js';
import { drawCandidates, type Candidate } from './pictures/candidates.js';
import { drawNext, drawScene, pickPicture, type DrawNextAnswer } from './pictures/draw.js';
import { transitionExplainer } from './state.js';
import { lockExplainer, readExplainer } from './store.js';

/** What this file needs of the pictures service: the real functions, unless a test says otherwise. */
export interface PictureDeps {
    drawScene: typeof drawScene;
    pickPicture: typeof pickPicture;
    drawNext: typeof drawNext;
    drawCandidates: typeof drawCandidates;
    allowanceStatus: typeof allowanceStatus;
}

const REAL_DEPS: PictureDeps = { drawScene, pickPicture, drawNext, drawCandidates, allowanceStatus };
let deps: PictureDeps = REAL_DEPS;

/** Test seam: answer the pictures service with these (the rest stay real), or `null` for all real again. Returns what was set before. */
export function setPictureDeps(next: Partial<PictureDeps> | null): PictureDeps {
    const previous = deps;
    deps = next ? { ...REAL_DEPS, ...next } : REAL_DEPS;
    return previous;
}

// ─── When a picture may be touched by hand ──────────────────────────────────────────────────────

/** The states the owner may draw, redraw and pick in (see the top of the file). */
export function picturesEditable(row: Pick<ExplainerRow, 'status' | 'failed_step'>): boolean {
    return row.status === 'drawing' || row.status === 'review' || row.status === 'ready' || row.status === 'scheduled' || (row.status === 'failed' && row.failed_step === 'draw');
}

function requireEditable(row: Pick<ExplainerRow, 'status' | 'failed_step'>, to: string): void {
    if (!picturesEditable(row)) {
        throw new ExplainerError('EXPLAINER_BAD_STATE', `This explainer is ${row.status}${row.status === 'failed' ? ` at the ${row.failed_step} step` : ''}, so its pictures cannot be ${to} now.`, { status: row.status, to });
    }
}

const notFound = (): ExplainerError => new ExplainerError('EXPLAINER_NOT_FOUND', 'No such explainer.');

/** A route's `:position`: a whole number from 0. Anything else is a scene that does not exist. */
function positionOf(raw: unknown): number {
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw;
    if (typeof raw === 'string' && /^\d{1,6}$/.test(raw)) return Number(raw);
    throw new ExplainerError('EXPLAINER_NOT_FOUND', 'No such scene.');
}

async function editableExplainer(creatorId: string, id: string, to: string): Promise<ExplainerRow> {
    const row = await readExplainer(pool, creatorId, id);
    if (!row) throw notFound();
    requireEditable(row, to);
    return row;
}

// ─── The owner's actions on one scene ───────────────────────────────────────────────────────────

/**
 * Draw or redraw one scene now. `note` is the owner's own words for this drawing ("he is holding a book, smiling"): text, or null/absent for none. The
 * pictures service refuses a note, a brief or a description that names a woman or a girl (422 `EXPLAINER_PROMPT_REFUSED`) before it spends anything.
 */
export async function drawOneScene(creatorId: string, rawId: unknown, rawPosition: unknown, body: unknown): Promise<{ scene: SceneView; allowance: AllowanceStatus | null }> {
    const id = explainerIdOf(rawId);
    const position = positionOf(rawPosition);
    const note = isPlainObject(body) ? body.note : undefined;
    if (note !== undefined && note !== null && typeof note !== 'string') throw new StudioError(400, 'note must be text.');
    await editableExplainer(creatorId, id, 'drawn');
    const out = await deps.drawScene({ creatorId, explainerId: id, position, note: note ?? null });
    return { scene: presentScene(out.scene), allowance: out.allowance };
}

/** Go back to one of a scene's earlier pictures (`index` is its place in `pictures`, newest first). Nothing is drawn and nothing is spent. */
export async function pickOneScene(creatorId: string, rawId: unknown, rawPosition: unknown, body: unknown): Promise<{ scene: SceneView }> {
    const id = explainerIdOf(rawId);
    const position = positionOf(rawPosition);
    const index = isPlainObject(body) ? body.index : undefined;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) throw new StudioError(400, 'index must be the number of an earlier picture, from 0.');
    await editableExplainer(creatorId, id, 'changed');
    const out = await deps.pickPicture({ creatorId, explainerId: id, position, index });
    return { scene: presentScene(out.scene) };
}

/** Four candidate pictures for a character's description, which count against the allowance. Not tied to an explainer: the look is the tenant's. */
export async function characterCandidates(creatorId: string, body: unknown): Promise<{ candidates: Candidate[] }> {
    const description = isPlainObject(body) ? body.description : undefined;
    if (description !== undefined && typeof description !== 'string') throw new StudioError(400, 'description must be text.');
    // An absent one is the pictures service's own refusal ("Describe the character first"), in its words and with its code.
    return deps.drawCandidates({ creatorId, description: description ?? '' });
}

/** Today's allowance, or null when no image provider is set up (there is nothing to count). */
export async function currentAllowance(): Promise<AllowanceStatus | null> {
    return deps.allowanceStatus();
}

// ─── The Mac's drawing step ─────────────────────────────────────────────────────────────────────

/** `job_id` of the request, or a 400: the worker must say which job it is running. */
function jobIdOf(body: unknown): string {
    const jobId = isPlainObject(body) ? body.job_id : undefined;
    if (typeof jobId !== 'string' || !UUID_PATTERN.test(jobId)) throw new StudioError(400, 'job_id must be the id of the explainer_draw job this worker is running.');
    return jobId.toLowerCase();
}

/** The job, if it is this tenant's: only what the check needs. */
async function lookAtDrawJob(creatorId: string, jobId: string): Promise<{ kind: string; status: string } | null> {
    const { rows } = await pool.query<{ kind: string; status: string }>('SELECT kind, status FROM studio_jobs WHERE id = $1 AND creator_id = $2', [jobId, creatorId]);
    return rows[0] ?? null;
}

/**
 * One step of the unattended drawing. Refused unless `job_id` is the explainer's own current `explainer_draw` job and it is claimed (see the top of the file);
 * then `drawNext`, and what the answer asks of the explainer.
 */
export async function drawNextStep(creatorId: string, rawId: unknown, body: unknown): Promise<DrawNextAnswer> {
    const id = explainerIdOf(rawId);
    const jobId = jobIdOf(body);
    const row = await readExplainer(pool, creatorId, id);
    if (!row) throw notFound();
    const job = row.job_id === jobId ? await lookAtDrawJob(creatorId, jobId) : null;
    if (!job || job.kind !== 'explainer_draw' || job.status !== 'claimed' || row.status !== 'drawing') {
        log('warn', 'explainer.draw_next_refused', { explainer_id: id, job_id: jobId, status: row.status, current_job: row.job_id === jobId, job_kind: job?.kind ?? null, job_status: job?.status ?? null });
        throw new ExplainerError('EXPLAINER_BAD_STATE', 'This is not the drawing job of this explainer, or the explainer is not being drawn.', { status: row.status, to: 'draw' });
    }

    const answer = await deps.drawNext({ creatorId, explainerId: id });

    if (answer.state === 'done') await moveToReview(creatorId, id, jobId);
    else if (answer.state === 'drawn') await clearPauseNote(creatorId, id, jobId);
    return answer;
}

/** Nothing is left to draw: `drawing` → `review`, if it is still `drawing` and still this job's (the owner may have deleted it, or started the drawing again). */
async function moveToReview(creatorId: string, id: string, jobId: string): Promise<void> {
    await withTransaction(async (client) => {
        const row = await lockExplainer(client, creatorId, id);
        if (!row || row.status !== 'drawing' || row.job_id !== jobId) return;
        // The job stays the explainer's until the worker completes it: `applyDraw` clears it then. `draw_paused_until` goes, and the move clears a pause note.
        await transitionExplainer(client, id, ['drawing'], 'review', { draw_paused_until: null }, creatorId);
        log('info', 'explainer.pictures_ready', { explainer_id: id, job_id: jobId });
    });
}

/** Drawing is going again: the note and the time of an earlier pause are no longer true. Matches nothing, and writes nothing, when there are none. */
async function clearPauseNote(creatorId: string, id: string, jobId: string): Promise<void> {
    await pool.query(
        `UPDATE explainers SET draw_paused_until = NULL, error = NULL, updated_at = NOW()
          WHERE id = $1 AND creator_id = $2 AND status = 'drawing' AND job_id = $3 AND (draw_paused_until IS NOT NULL OR error IS NOT NULL)`,
        [id, creatorId, jobId]
    );
}
