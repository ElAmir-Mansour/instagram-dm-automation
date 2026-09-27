/**
 * Carousel Studio routes, under `/api/studio` (STUDIO.md §4, §5, §10), and the Monteur's
 * (MONTEUR.md §4, §5).
 *
 * Two routers, because the worker is not a dashboard user and carries no session:
 *
 *   studioWorkerRouter — mounted ABOVE `requireAuth` in api.ts, like `tiktokPublicRouter`.
 *     Authenticated only by the worker's bearer token, which resolves its tenant; every call
 *     acts as that tenant and nothing else.
 *     POST /worker/claim               { name, kinds? } → 200 { job } | 204; queues the Monteur's daily scan first
 *     POST /worker/jobs/:id/progress   { progress } → 204 (the heartbeat)
 *     POST /worker/jobs/:id/complete   { result } → 204, and the job's side effects
 *     POST /worker/jobs/:id/fail       { error } → 204
 *     POST /worker/upload              { filename, mime_type, base64_data } → { id, url }
 *     POST /worker/uploads/sign        { filename, mime_type, size_bytes } → { id, url, upload }
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
import { refreshLessons } from '../services/monteur/analyst.js';
import { approveClip, patchClip, rejectClip, rerenderClip } from '../services/monteur/clips.js';
import { enqueueDueMonteurScan, requestFolderPick, runMonteurNow } from '../services/monteur/daily.js';
import { signWorkerUpload } from '../services/monteur/uploads.js';
import { getMonteurView, presentLessons, retrySource } from '../services/monteur/view.js';
import { clipText, requireId, STUDIO_MIGRATION_HINT, StudioError } from '../services/studio/common.js';
import {
    createDraft, deleteDraft, getDraft, listDrafts, patchDraft, planDrafts, renderDraft, rewriteDraftSlide,
    setTikTokPublic,
} from '../services/studio/drafts.js';
import { claimJob, completeJob, failJob, jobCounts, reportProgress, STUDIO_JOB_KINDS } from '../services/studio/jobs.js';
import { enqueueIndex, enqueueScan, getLesson, indexMissing, lessonCounts, listLessons } from '../services/studio/lessons.js';
import { queuedTikTokCount, runTikTokBatch, scheduleDraft } from '../services/studio/schedule.js';
import { getStudioSettings, updateStudioSettings } from '../services/studio/settings.js';
import { nextFreeSlots, parseSlotCount } from '../services/studio/slots.js';
import {
    authenticateWorker, createWorker, listWorkers, revokeWorker, workerSummary, type AuthenticatedWorker,
} from '../services/studio/worker.js';
import { describeError, log } from '../utils/log.js';
import type { StudioJobKind } from '../db/rows.js';

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

/**
 * `{ kinds? }` narrows a claim to some job kinds: a worker busy with a long render polls a fast
 * lane for `pick_folder`, so a person waiting at the folder dialog is not kept waiting.
 */
export function parseClaimKinds(body: unknown): StudioJobKind[] | null {
    const kinds = body && typeof body === 'object' ? (body as { kinds?: unknown }).kinds : undefined;
    if (kinds === undefined || kinds === null) return null;
    if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((k) => !(STUDIO_JOB_KINDS as readonly unknown[]).includes(k))) {
        throw new StudioError(400, `kinds must be a list of job kinds: ${STUDIO_JOB_KINDS.join(', ')}.`);
    }
    return [...new Set(kinds as StudioJobKind[])];
}

studioWorkerRouter.post('/worker/claim', handle('studio.claim_failed', 'Failed to claim a job.', async (req, res) => {
    const creatorId = workerTenant(res);
    const kinds = parseClaimKinds(req.body);
    // The Monteur's daily run (MONTEUR.md §7) needs no cron: a worker that polls is a worker that
    // can scan. Queued before the claim, so this very claim can hand it out. It must never stop the
    // worker claiming anything else, so its failure is logged, not answered.
    await enqueueDueMonteurScan(creatorId).catch((err: unknown) => {
        log('error', 'monteur.daily_run_failed', { creator_id: creatorId, ...describeError(err) });
    });
    // The body's `name` is not stored: the worker's name is the label the operator gave it.
    const job = await claimJob(creatorId, kinds);
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
    const store = await getMediaStore();
    const { id } = await store.put({
        creatorId: workerTenant(res),
        filename: clipText(filename, 200) ?? 'studio-upload',
        mimeType,
        data,
    });
    res.status(201).json({ id, url: store.publicUrl(id, base) });
}));

// A rendered reel: tens of MB, straight to Supabase Storage through a signed URL (MONTEUR.md §4).
studioWorkerRouter.post('/worker/uploads/sign', handle('monteur.sign_failed', 'Failed to sign the upload.', async (req, res) => {
    res.status(201).json(await signWorkerUpload(workerTenant(res), req.body, () => getPublicBaseUrl(requestOrigin(req))));
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

// ── The Monteur (MONTEUR.md §5) ──
// Its settings are the `monteur` section of GET/PUT /settings; there is no route of their own.

studioRouter.get('/monteur', handle('monteur.view_failed', 'Failed to read the Monteur.', async (req, res) => {
    res.json(await getMonteurView(getTenantId(req)));
}));

studioRouter.post('/monteur/run', handle('monteur.run_failed', 'Failed to queue the scan.', async (req, res) => {
    res.json({ job: await runMonteurNow(getTenantId(req)) });
}));

studioRouter.post('/monteur/pick-folder', handle('monteur.pick_folder_failed', 'Failed to ask for the folder.', async (req, res) => {
    res.json({ job: await requestFolderPick(getTenantId(req)) });
}));

studioRouter.post('/monteur/sources/:id/retry', handle('monteur.retry_failed', 'Failed to retry the video.', async (req, res) => {
    res.json(await retrySource(getTenantId(req), requireId(req.params.id, 'source')));
}));

studioRouter.patch('/monteur/clips/:id', handle('monteur.clip_patch_failed', 'Failed to save the reel.', async (req, res) => {
    res.json(await patchClip(getTenantId(req), requireId(req.params.id, 'clip'), req.body));
}));

studioRouter.post('/monteur/clips/:id/approve', handle('monteur.approve_failed', 'Failed to schedule the reel.', async (req, res) => {
    const creatorId = getTenantId(req);
    const outcome = await approveClip(creatorId, requireId(req.params.id, 'clip'), req.body);
    await writeAudit(await actorFromSession(req.session), {
        action: AUDIT_ACTIONS.monteurApprove,
        targetType: 'clip_draft',
        targetId: outcome.clip.id,
        detail: {
            scheduled_time: outcome.scheduled_time,
            post_ids: outcome.rows.map((row) => row.id),
            campaign_id: outcome.campaign?.id ?? null,
            campaign_created: outcome.campaign?.created ?? false,
        },
    });
    // `campaign` says whether the keyword's campaign was created now or an active one reused.
    res.json({ clip: outcome.clip, scheduled_time: outcome.scheduled_time, campaign: outcome.campaign });
}));

studioRouter.post('/monteur/clips/:id/reject', handle('monteur.reject_failed', 'Failed to reject the reel.', async (req, res) => {
    res.json(await rejectClip(getTenantId(req), requireId(req.params.id, 'clip')));
}));

studioRouter.post('/monteur/clips/:id/rerender', handle('monteur.rerender_failed', 'Failed to render the reel again.', async (req, res) => {
    res.json(await rerenderClip(getTenantId(req), requireId(req.params.id, 'clip')));
}));

studioRouter.post('/monteur/lessons/refresh', handle('monteur.lessons_failed', 'Failed to run the Analyst.', async (req, res) => {
    res.json(presentLessons(await refreshLessons(getTenantId(req))));
}));
