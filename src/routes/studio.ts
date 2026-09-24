/**
 * Carousel Studio routes, under `/api/studio` (STUDIO.md §4, §5, §10).
 *
 * Two routers, because the worker is not a dashboard user and carries no session:
 *
 *   studioWorkerRouter — mounted ABOVE `requireAuth` in api.ts, like `tiktokPublicRouter`.
 *     Authenticated only by the worker's bearer token, which resolves its tenant; every call
 *     acts as that tenant and nothing else.
 *     POST /worker/claim               { name } → 200 { job } | 204
 *     POST /worker/jobs/:id/progress   { progress } → 204 (the heartbeat)
 *     POST /worker/jobs/:id/complete   { result } → 204, and the job's side effects
 *     POST /worker/jobs/:id/fail       { error } → 204
 *     POST /worker/upload              { filename, mime_type, base64_data } → { id, url }
 *
 *   studioRouter — mounted BELOW `resolveTenant`, so every route acts as the session's tenant,
 *     and every route needs the operator role. Minting and revoking a worker needs the owner:
 *     a worker token is a standing credential for the tenant's media store.
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from '../services/audit.js';
import { getPublicBaseUrl, getTikTokPostingFlags } from '../services/appSettings.js';
import { isMissingSchema } from '../services/health.js';
import { getMediaStore } from '../services/storage.js';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { clipText, requireId, STUDIO_MIGRATION_HINT, StudioError } from '../services/studio/common.js';
import {
    createDraft, deleteDraft, getDraft, listDrafts, patchDraft, planDrafts, renderDraft, rewriteDraftSlide,
    setTikTokPublic,
} from '../services/studio/drafts.js';
import { claimJob, completeJob, failJob, jobCounts, reportProgress } from '../services/studio/jobs.js';
import { enqueueIndex, enqueueScan, getLesson, indexMissing, lessonCounts, listLessons } from '../services/studio/lessons.js';
import { queuedTikTokCount, runTikTokBatch, scheduleDraft } from '../services/studio/schedule.js';
import { getStudioSettings, updateStudioSettings } from '../services/studio/settings.js';
import { nextFreeSlots, parseSlotCount } from '../services/studio/slots.js';
import {
    authenticateWorker, createWorker, listWorkers, revokeWorker, workerSummary, type AuthenticatedWorker,
} from '../services/studio/worker.js';
import { describeError, log } from '../utils/log.js';

type Handler = (req: Request, res: Response) => Promise<void>;

/**
 * Every route's error handling, once: a StudioError is the answer as-is, a missing v21 table is
 * a 503 that says which migration to run, anything else is logged and a 500.
 */
function handle(event: string, fallback: string, fn: Handler) {
    return async (req: Request, res: Response): Promise<void> => {
        try {
            await fn(req, res);
        } catch (err) {
            if (err instanceof StudioError) {
                res.status(err.status).json(err.problems ? { error: err.message, problems: err.problems } : { error: err.message });
                return;
            }
            if (isMissingSchema(err)) {
                log('error', 'studio.schema_missing', describeError(err));
                res.status(503).json({ error: STUDIO_MIGRATION_HINT });
                return;
            }
            log('error', event, describeError(err));
            res.status(500).json({ error: fallback });
        }
    };
}

// ─── Worker ─────────────────────────────────────────────────────────────────────────────

/** Uploads a worker may make: slides and thumbnails. JPEG is what Instagram takes. */
export const STUDIO_UPLOAD_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const MAX_STUDIO_UPLOAD_BYTES = 3 * 1024 * 1024;

/**
 * The type the bytes actually are, from their first bytes. `/api/uploads/:id` serves the stored
 * type as Content-Type, and Instagram refuses a PNG labelled JPEG at publish time — hours after
 * the render, in a card nobody is looking at.
 */
export function sniffImageType(data: Buffer): string | null {
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
    if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'image/png';
    }
    if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
        return 'image/webp';
    }
    return null;
}

function requestOrigin(req: Request): string | null {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0]!.trim();
    const host = req.get('host');
    return host ? `${proto}://${host}` : null;
}

/**
 * The bearer token is the only credential. A failure is logged, because otherwise a worker
 * with a stale token looks exactly like a Mac that is switched off.
 */
async function requireWorker(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        const auth = await authenticateWorker(req.headers.authorization);
        if (!auth.ok) {
            log('warn', 'studio.worker_auth_rejected', { reason: auth.reason, path: req.path });
            res.status(401).json({
                error: auth.reason === 'missing'
                    ? 'Send the worker token as Authorization: Bearer <token>.'
                    : 'This worker token is not valid, or it was revoked. Create a new worker in Studio settings.',
            });
            return;
        }
        res.locals.worker = auth.worker;
        next();
    } catch (err) {
        if (isMissingSchema(err)) {
            res.status(503).json({ error: STUDIO_MIGRATION_HINT });
            return;
        }
        log('error', 'studio.worker_auth_failed', describeError(err));
        res.status(500).json({ error: 'Could not check the worker token.' });
    }
}

function workerTenant(res: Response): string {
    return (res.locals.worker as AuthenticatedWorker).creatorId;
}

export const studioWorkerRouter = Router();

// `/worker` matches whole segments only, so `/workers` (the operator's list) falls through.
studioWorkerRouter.use('/worker', requireWorker);

studioWorkerRouter.post('/worker/claim', handle('studio.claim_failed', 'Failed to claim a job.', async (_req, res) => {
    // The body's `name` is not stored: the worker's name is the label the operator gave it.
    const job = await claimJob(workerTenant(res));
    if (!job) {
        res.status(204).end();
        return;
    }
    res.status(200).json({ job });
}));

studioWorkerRouter.post('/worker/jobs/:id/progress', handle('studio.progress_failed', 'Failed to record progress.', async (req, res) => {
    await reportProgress(workerTenant(res), requireId(req.params.id, 'job'), clipText(req.body?.progress, 500));
    res.status(204).end();
}));

studioWorkerRouter.post('/worker/jobs/:id/complete', handle('studio.complete_failed', 'Failed to apply the result.', async (req, res) => {
    await completeJob(workerTenant(res), requireId(req.params.id, 'job'), req.body?.result);
    res.status(204).end();
}));

studioWorkerRouter.post('/worker/jobs/:id/fail', handle('studio.fail_failed', 'Failed to record the failure.', async (req, res) => {
    const error = clipText(req.body?.error, 2000) ?? 'The worker reported a failure without saying why.';
    await failJob(workerTenant(res), requireId(req.params.id, 'job'), error);
    res.status(204).end();
}));

studioWorkerRouter.post('/worker/upload', handle('studio.upload_failed', 'Failed to store the upload.', async (req, res) => {
    const { filename, mime_type: mimeType, base64_data: base64 } = req.body ?? {};
    if (typeof mimeType !== 'string' || !STUDIO_UPLOAD_TYPES.has(mimeType)) {
        throw new StudioError(400, `mime_type must be one of ${[...STUDIO_UPLOAD_TYPES].join(', ')}.`);
    }
    if (typeof base64 !== 'string' || !base64) throw new StudioError(400, 'base64_data is required.');
    const data = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (data.length === 0) throw new StudioError(400, 'base64_data decodes to nothing.');
    if (data.length > MAX_STUDIO_UPLOAD_BYTES) {
        throw new StudioError(413, `An upload is at most 3MB decoded; this one is ${(data.length / 1024 / 1024).toFixed(1)}MB.`);
    }
    const actual = sniffImageType(data);
    if (actual !== mimeType) {
        throw new StudioError(400, `The bytes are ${actual ?? 'not an image this accepts'}, not ${mimeType}.`);
    }
    const base = await getPublicBaseUrl(requestOrigin(req));
    if (!base) throw new StudioError(500, 'No public address for this app: set it in Settings → TikTok app.');

    // Through the store, like POST /api/upload, and as the worker's tenant.
    const store = getMediaStore();
    const { id } = await store.put({
        creatorId: workerTenant(res),
        filename: clipText(filename, 200) ?? 'studio-upload',
        mimeType,
        data,
    });
    res.status(201).json({ id, url: store.publicUrl(id, base) });
}));

// ─── Operator ───────────────────────────────────────────────────────────────────────────

export const studioRouter = Router();

const canOperate = requireTenantRole('operator');
const canAdminister = requireTenantRole('owner');

studioRouter.use(canOperate);

studioRouter.get('/status', handle('studio.status_failed', 'Failed to read the Studio status.', async (req, res) => {
    const creatorId = getTenantId(req);
    const [worker, lessons, jobs, flags, queued] = await Promise.all([
        workerSummary(creatorId), lessonCounts(creatorId), jobCounts(creatorId), getTikTokPostingFlags(), queuedTikTokCount(creatorId),
    ]);
    res.json({ worker, lessons, jobs, tiktok: { audited: flags.audited, queued } });
}));

// ── Settings and workers (§10) ──

studioRouter.get('/settings', handle('studio.settings_read_failed', 'Failed to read the Studio settings.', async (req, res) => {
    res.json({ settings: await getStudioSettings(getTenantId(req)) });
}));

studioRouter.put('/settings', handle('studio.settings_save_failed', 'Failed to save the Studio settings.', async (req, res) => {
    const creatorId = getTenantId(req);
    const { settings, changed } = await updateStudioSettings(creatorId, req.body);
    await writeAudit(await actorFromSession(req.session), {
        action: AUDIT_ACTIONS.studioSettingsWrite, targetType: 'creator', targetId: creatorId, detail: { sections: changed },
    });
    res.json({ settings });
}));

studioRouter.get('/workers', handle('studio.workers_read_failed', 'Failed to list the workers.', async (req, res) => {
    res.json({ workers: await listWorkers(getTenantId(req)) });
}));

studioRouter.post('/workers', canAdminister, handle('studio.worker_create_failed', 'Failed to create the worker.', async (req, res) => {
    const creatorId = getTenantId(req);
    const { worker, token } = await createWorker(creatorId, req.body?.name);
    // The detail names the worker, never the credential: `redactDetail` would blank a key
    // containing "token" anyway, and there is nothing about the token worth keeping.
    await writeAudit(await actorFromSession(req.session), {
        action: AUDIT_ACTIONS.studioWorkerCreate, targetType: 'studio_worker', targetId: worker.id, detail: { name: worker.name },
    });
    res.status(201).json({ worker, token });
}));

studioRouter.delete('/workers/:id', canAdminister, handle('studio.worker_revoke_failed', 'Failed to revoke the worker.', async (req, res) => {
    const worker = await revokeWorker(getTenantId(req), requireId(req.params.id, 'worker'));
    await writeAudit(await actorFromSession(req.session), {
        action: AUDIT_ACTIONS.studioWorkerRevoke, targetType: 'studio_worker', targetId: worker.id, detail: { name: worker.name },
    });
    res.status(204).end();
}));

// ── Library ──

studioRouter.get('/lessons', handle('studio.lessons_failed', 'Failed to list the lessons.', async (req, res) => {
    res.json({ lessons: await listLessons(getTenantId(req)) });
}));

studioRouter.get('/lessons/:id', handle('studio.lesson_failed', 'Failed to read the lesson.', async (req, res) => {
    res.json(await getLesson(getTenantId(req), requireId(req.params.id, 'lesson')));
}));

studioRouter.post('/scan', handle('studio.scan_failed', 'Failed to queue the scan.', async (req, res) => {
    res.json({ job: await enqueueScan(getTenantId(req)) });
}));

studioRouter.post('/lessons/index-missing', handle('studio.index_missing_failed', 'Failed to queue the lessons.', async (req, res) => {
    res.json({ count: await indexMissing(getTenantId(req)) });
}));

studioRouter.post('/lessons/:id/index', handle('studio.index_failed', 'Failed to queue the lesson.', async (req, res) => {
    res.json({ job: await enqueueIndex(getTenantId(req), requireId(req.params.id, 'lesson')) });
}));

// ── Drafts ──

studioRouter.get('/drafts', handle('studio.drafts_failed', 'Failed to list the drafts.', async (req, res) => {
    res.json({ drafts: await listDrafts(getTenantId(req)) });
}));

studioRouter.get('/drafts/:id', handle('studio.draft_failed', 'Failed to read the draft.', async (req, res) => {
    res.json(await getDraft(getTenantId(req), requireId(req.params.id, 'draft')));
}));

studioRouter.post('/drafts', handle('studio.draft_create_failed', 'Failed to create the draft.', async (req, res) => {
    // 201 even when the draft came back `failed`: the row exists, and the failure is its content.
    res.status(201).json({ draft: await createDraft(getTenantId(req), req.body) });
}));

studioRouter.patch('/drafts/:id', handle('studio.draft_patch_failed', 'Failed to save the draft.', async (req, res) => {
    res.json({ draft: await patchDraft(getTenantId(req), requireId(req.params.id, 'draft'), req.body) });
}));

studioRouter.post('/drafts/:id/rewrite', handle('studio.draft_rewrite_failed', 'Failed to rewrite the slide.', async (req, res) => {
    res.json({ draft: await rewriteDraftSlide(getTenantId(req), requireId(req.params.id, 'draft'), req.body) });
}));

studioRouter.post('/drafts/:id/render', handle('studio.draft_render_failed', 'Failed to queue the render.', async (req, res) => {
    res.json({ job: await renderDraft(getTenantId(req), requireId(req.params.id, 'draft')) });
}));

studioRouter.post('/drafts/:id/schedule', handle('studio.draft_schedule_failed', 'Failed to schedule the draft.', async (req, res) => {
    const creatorId = getTenantId(req);
    const outcome = await scheduleDraft(creatorId, requireId(req.params.id, 'draft'), req.body);
    await writeAudit(await actorFromSession(req.session), {
        action: AUDIT_ACTIONS.studioSchedule,
        targetType: 'carousel_draft',
        targetId: outcome.draft.id,
        detail: {
            scheduled_time: outcome.draft.schedule?.scheduled_time ?? null,
            post_ids: outcome.rows.map((row) => row.id),
            tiktok: outcome.draft.schedule?.tiktok ?? 'none',
            campaign_id: outcome.campaign?.id ?? null,
            campaign_created: outcome.campaign?.created ?? false,
        },
    });
    res.json(outcome);
}));

studioRouter.delete('/drafts/:id', handle('studio.draft_delete_failed', 'Failed to delete the draft.', async (req, res) => {
    await deleteDraft(getTenantId(req), requireId(req.params.id, 'draft'));
    res.status(204).end();
}));

studioRouter.post('/drafts/:id/tiktok-public', handle('studio.tiktok_public_failed', 'Failed to save the tick.', async (req, res) => {
    res.json({ draft: await setTikTokPublic(getTenantId(req), requireId(req.params.id, 'draft'), req.body) });
}));

studioRouter.post('/tiktok/batch', handle('studio.tiktok_batch_failed', 'Failed to send the TikTok batch.', async (req, res) => {
    const creatorId = getTenantId(req);
    const { queued, skipped, rows } = await runTikTokBatch(creatorId);
    await writeAudit(await actorFromSession(req.session), {
        action: AUDIT_ACTIONS.studioTikTokBatch,
        targetType: 'creator',
        targetId: creatorId,
        detail: { queued, skipped: skipped.length, post_ids: rows.map((row) => row.id) },
    });
    res.json({ queued, skipped });
}));

studioRouter.get('/slots', handle('studio.slots_failed', 'Failed to find free slots.', async (req, res) => {
    const creatorId = getTenantId(req);
    const { schedule } = await getStudioSettings(creatorId);
    res.json({ slots: await nextFreeSlots(creatorId, schedule, parseSlotCount(req.query.count)) });
}));

studioRouter.post('/plan', handle('studio.plan_failed', 'Failed to plan the posts.', async (req, res) => {
    res.json({ proposals: await planDrafts(getTenantId(req), req.body) });
}));
