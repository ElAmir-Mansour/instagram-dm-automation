/**
 * What the Studio queue does with the four explainer job kinds when a job ends (jobs.ts `completeJob` and `failJob` call these, inside the job's
 * transaction, as they call `applyInfographicRender` for an infographic).
 *
 * In E1 both are typed no-ops that log `explainer.result_unhandled`. Nothing queues these jobs yet (there is no route and the switch is off), so
 * a job that does arrive is a surprise: it is logged, its result is dropped and nothing is half-applied. E2 replaces the bodies with the
 * lifecycle: the writer's draft, the voice's timings, the draw loop's end, the render's files, and the failed step of each.
 */
import type { StudioJobKind, StudioJobRow } from '../../db/rows.js';
import { log } from '../../utils/log.js';
import type { Exec } from '../studio/common.js';

export const EXPLAINER_JOB_KINDS = ['explainer_write', 'explainer_voice', 'explainer_draw', 'explainer_render'] as const satisfies readonly StudioJobKind[];
export type ExplainerJobKind = (typeof EXPLAINER_JOB_KINDS)[number];

export function isExplainerJobKind(kind: string): kind is ExplainerJobKind {
    return (EXPLAINER_JOB_KINDS as readonly string[]).includes(kind);
}

/** The part of a locked `studio_jobs` row the appliers need: the job's tenant, its kind, and the payload it was queued with. */
export type ExplainerJob = Pick<StudioJobRow, 'id' | 'creator_id' | 'payload'> & { kind: ExplainerJobKind };

/** What `completeJob` stores and reports, as for every other kind: `dropped` is a result that was not applied. */
export interface ExplainerApplied {
    outcome: 'applied' | 'dropped';
    stored: unknown;
}

/**
 * Apply a finished job's result to its explainer, or drop it. E1: logs and drops. `exec` is the transaction's client, for E2's writes.
 */
export async function applyExplainerResult(_exec: Exec, job: ExplainerJob, _result: unknown): Promise<ExplainerApplied> {
    log('warn', 'explainer.result_unhandled', { job_id: job.id, kind: job.kind, creator_id: job.creator_id, phase: 'result' });
    return { outcome: 'dropped', stored: { dropped: 'not_implemented' } };
}

/**
 * A job failed or went quiet three times: the explainer goes `failed` at the step the job was for, with `error`. E1: logs only, and never the
 * text of `error`, which may quote a prompt, a path or a key.
 */
export async function applyExplainerFailure(_exec: Exec, job: ExplainerJob, _error: string): Promise<void> {
    log('warn', 'explainer.result_unhandled', { job_id: job.id, kind: job.kind, creator_id: job.creator_id, phase: 'failure' });
}
