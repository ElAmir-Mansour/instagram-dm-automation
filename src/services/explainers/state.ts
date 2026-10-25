/**
 * The status machine of an explainer (data-model.md §5), and the one function that moves it.
 *
 *   writing ─writer result→ draft ─approve→ voicing ─voice result→ drawing ─every scene drawn→ review ─approve pictures→ rendering
 *      ↑                      │                                                                                             │
 *      └──── rewrite ─────────┘                                                              ready ←── render result ───────┘
 *                                                                                              │  ↑
 *                                                                                  schedule ───┘  └─── re-render (ready → rendering)
 *   any running step ─job failed or refused→ failed (failed_step, error) ─retry→ the state that step runs in
 *   a narration edit after voicing makes the audio stale; then drawing, review or ready may go back to voicing (re-voice)
 *
 * Editing a label, a brief or a picture never moves the status (review, ready and scheduled stay what they are), so those edits are not here.
 *
 * `canMove` is the table, pure. `transitionExplainer` is the only code that writes `explainers.status`: it locks the row, checks the move
 * against the caller's own list of states AND the table, and writes the new state with whatever else changes in the same statement. A job's
 * result is applied only if `explainers.job_id` is that job (E2 checks it before moving), so two writers racing for one explainer take turns
 * on the row lock instead of both seeing the state the other is about to leave.
 */
import type {
    ExplainerAudio, ExplainerDraft, ExplainerRender, ExplainerRow, ExplainerSchedule, ExplainerStatus, ExplainerStep, ExplainerWords,
} from '../../db/rows.js';
import { log } from '../../utils/log.js';
import type { Exec } from '../studio/common.js';
import { ExplainerError } from './errors.js';

export const EXPLAINER_STATUSES: readonly ExplainerStatus[] = [
    'writing', 'draft', 'voicing', 'drawing', 'review', 'rendering', 'ready', 'scheduled', 'failed',
];
export const EXPLAINER_STEPS: readonly ExplainerStep[] = ['write', 'voice', 'draw', 'render', 'schedule'];

/**
 * Where a retry of a failed step goes: the state the step runs in. A failed schedule goes back to `ready`, where Schedule is pressed again
 * (scheduling is one request, not a job, so it has no state of its own).
 */
export const RETRY_STATUS: Readonly<Record<ExplainerStep, ExplainerStatus>> = {
    write: 'writing', voice: 'voicing', draw: 'drawing', render: 'rendering', schedule: 'ready',
};

/** The step that runs in a state, and so the only step that can fail from it: what keeps a retry from jumping over a gate the owner has not passed. */
const STEP_OF: Readonly<Partial<Record<ExplainerStatus, ExplainerStep>>> = {
    writing: 'write', voicing: 'voice', drawing: 'draw', rendering: 'render', ready: 'schedule',
};

/** The ordinary moves, with no failure and no stale audio. `failed` and a re-voice are rules of their own in `canMove`. */
const MOVES: Readonly<Record<ExplainerStatus, readonly ExplainerStatus[]>> = {
    writing: ['draft'],
    draft: ['writing', 'voicing'],
    voicing: ['drawing'],
    drawing: ['review'],
    review: ['rendering'],
    rendering: ['ready'],
    ready: ['rendering', 'scheduled'],
    scheduled: [],
    failed: [],
};

/** Where a re-voice may start: after the narration was voiced, until it is posted. */
const REVOICE_FROM: readonly ExplainerStatus[] = ['drawing', 'review', 'ready'];

export interface MoveContext {
    /** Moving TO `failed`: the step being recorded as failed. Moving FROM `failed`: the step that failed. */
    failedStep?: ExplainerStep | null;
    /** The narration changed since the audio was voiced (`isAudioStale`): the only thing that allows a re-voice. */
    audioStale?: boolean;
}

/** Whether an explainer in `from` may be moved to `to`. Pure: the table of data-model §5 and nothing else. */
export function canMove(from: ExplainerStatus, to: ExplainerStatus, ctx: MoveContext = {}): boolean {
    if (to === 'failed') return from !== 'failed' && ctx.failedStep != null && STEP_OF[from] === ctx.failedStep;
    if (from === 'failed') return ctx.failedStep != null && RETRY_STATUS[ctx.failedStep] === to;
    if (to === 'voicing' && REVOICE_FROM.includes(from)) return ctx.audioStale === true;
    return MOVES[from].includes(to);
}

/** Whether the narration moved on since the audio was made: the audio was voiced at another `draft_version`. No audio is not out of date: it is missing. */
export function isAudioStale(row: Pick<ExplainerRow, 'audio' | 'draft_version'>): boolean {
    return row.audio !== null && row.audio.version !== row.draft_version;
}

/** What else a move may change in the same statement. Anything not listed here is not a column a transition may touch. */
export interface ExplainerPatch {
    title?: string | null;
    error?: string | null;
    failed_step?: ExplainerStep | null;
    rewrite_note?: string | null;
    job_id?: string | null;
    draft_version?: number;
    draw_paused_until?: Date | string | null;
    draft?: ExplainerDraft | null;
    audio?: ExplainerAudio | null;
    words?: ExplainerWords | null;
    render?: ExplainerRender | null;
    schedule?: ExplainerSchedule | null;
}

/** The columns a patch may set, and how a value is cast: the whitelist the statement's column names come from, never the caller's keys. */
const PATCH_COLUMNS: Readonly<Record<keyof ExplainerPatch, '' | '::jsonb'>> = {
    title: '', error: '', failed_step: '', rewrite_note: '', job_id: '', draft_version: '', draw_paused_until: '',
    draft: '::jsonb', audio: '::jsonb', words: '::jsonb', render: '::jsonb', schedule: '::jsonb',
};

/**
 * Move one explainer to `to`, with the row locked, and give back the row as written.
 *
 * `allowedFrom` is the states the CALLER's action is for (approve is for `draft`); `canMove` is the table; the move is made only when the row
 * is in one of the first and the second allows it, else 409 `EXPLAINER_BAD_STATE` and nothing is written. A re-voice also needs the audio to be
 * out of date (`isAudioStale`, judged on the locked row).
 *
 * The move writes `status` and `updated_at`, and what `patch` carries: a value sets the column, `null` clears it, `undefined` leaves it alone,
 * and a key that is not one of `ExplainerPatch` throws before the database is touched. Moving to `failed` needs `failed_step` (the step must be
 * the one running in the state it leaves) and normally `error`; moving on to any other state clears `failed_step` and `error` unless `patch`
 * sets them, so an old failure or pause note never outlives the state it was about.
 *
 * `creatorId` scopes the lock to the explainer's tenant: pass it from any path that has one (every route and every job does), and another
 * tenant's explainer is 404 `EXPLAINER_NOT_FOUND`. Without it the row is locked by id alone, for a caller that has already scoped it.
 */
export async function transitionExplainer(
    exec: Exec, id: string, allowedFrom: readonly ExplainerStatus[], to: ExplainerStatus, patch: ExplainerPatch = {}, creatorId?: string
): Promise<ExplainerRow> {
    for (const key of Object.keys(patch)) {
        if (!Object.hasOwn(PATCH_COLUMNS, key)) throw new Error(`transitionExplainer: "${key}" is not a column it may set.`);
    }

    const { rows: locked } = await exec.query<ExplainerRow>(
        'SELECT * FROM explainers WHERE id = $1 AND ($2::uuid IS NULL OR creator_id = $2) FOR UPDATE', [id, creatorId ?? null]
    );
    const row = locked[0];
    if (!row) throw new ExplainerError('EXPLAINER_NOT_FOUND', 'No such explainer.');

    const ctx: MoveContext = { audioStale: isAudioStale(row), failedStep: to === 'failed' ? patch.failed_step : row.failed_step };
    if (!allowedFrom.includes(row.status) || !canMove(row.status, to, ctx)) {
        throw new ExplainerError('EXPLAINER_BAD_STATE', `This explainer is ${row.status}, so it cannot go to ${to}.`, { status: row.status, to });
    }

    const params: unknown[] = [id, to];
    const sets = ['status = $2'];
    for (const [column, cast] of Object.entries(PATCH_COLUMNS) as [keyof ExplainerPatch, '' | '::jsonb'][]) {
        const value = patch[column];
        if (value === undefined) continue;
        params.push(cast && value !== null ? JSON.stringify(value) : value);
        sets.push(`${column} = $${params.length}${cast}`);
    }
    // A failure or a pause note belongs to the state it was written in: moving on clears it, unless this move is writing a new one.
    if (to !== 'failed') {
        if (patch.failed_step === undefined) sets.push('failed_step = NULL');
        if (patch.error === undefined) sets.push('error = NULL');
    }
    sets.push('updated_at = NOW()');

    const { rows } = await exec.query<ExplainerRow>(`UPDATE explainers SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    if (!rows[0]) throw new Error('explainers update returned no row.');
    log('info', 'explainer.transition', { explainer_id: id, from: row.status, to });
    return rows[0];
}
