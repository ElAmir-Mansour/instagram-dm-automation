/**
 * Split tests: `/api/ads/studies` (phase A12, contracts/dashboard-api.md "Tests"). Mounted inside `adsRouter`, below the ads feature
 * switch. GET is any member's and reads Postgres only; making, starting and stopping a test are the owner's. Starting spends money, so
 * it needs `confirm: true` and re-runs the money rule (studies.ts). Every write answers the ops it queued; the screen polls
 * `GET /api/ads/ops/:id`.
 */
import { Router } from 'express';
import type { Response } from 'express';
import { AdsError, metaRefusal } from '../services/adBoosts.js';
import { AdsGraphError } from '../services/ads/graph.js';
import { createStudy, listStudies, startStudy, stopStudy, StudyError, type StudyPorts } from '../services/ads/studies.js';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { describeError, log } from '../utils/log.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function studiesFail(res: Response, err: unknown, what: string): void {
    if (err instanceof StudyError) {
        res.status(err.status).json({ error: err.message, code: err.code, ...(err.field ? { field: err.field } : {}), ...err.extra });
        return;
    }
    // A2's switches and the Graph client (PAYMENT_METHOD_MISSING, OVER_DAILY_MAX, RATE_LIMITED with retryAt, META_ERROR, ...).
    if (err instanceof AdsError || err instanceof AdsGraphError) {
        const r = metaRefusal(err);
        res.status(r.status).json({
            error: r.message, code: r.code, ...(r.field ? { field: r.field } : {}),
            ...(r.extra.retryAt ? { retryAt: r.extra.retryAt.toISOString() } : {}),
        });
        return;
    }
    log('error', `ads.${what}_failed`, describeError(err));
    res.status(500).json({ error: `Failed to ${what.replace(/_/g, ' ')}.` });
}

/** The routes, given the ports (a function, so the wiring is read per request and tests can swap it). */
export function studiesRouter(ports: () => StudyPorts): Router {
    const router = Router();
    const member = requireTenantRole('viewer');
    const owner = requireTenantRole('owner');
    const userId = (req: { session?: { userId?: string | null } }) => req.session?.userId ?? null;

    router.get('/studies', member, async (req, res) => {
        try {
            res.json(await listStudies(ports(), getTenantId(req)));
        } catch (err) {
            studiesFail(res, err, 'list_studies');
        }
    });

    router.post('/studies', owner, async (req, res) => {
        try {
            const creatorId = getTenantId(req);
            const answer = await createStudy(ports(), creatorId, userId(req), req.body);
            log('info', 'ads.study_created', { creator_id: creatorId, study_id: answer.study.id, type: answer.study.type, arms: answer.study.cells.length });
            res.status(201).json(answer);
        } catch (err) {
            studiesFail(res, err, 'create_study');
        }
    });

    router.post('/studies/:id/start', owner, async (req, res) => {
        const id = String(req.params['id'] ?? '');
        if (!UUID_RE.test(id)) {
            res.status(404).json({ error: 'That test does not exist.', code: 'NOT_FOUND' });
            return;
        }
        try {
            const creatorId = getTenantId(req);
            const answer = await startStudy(ports(), creatorId, userId(req), id, req.body);
            log('info', 'ads.study_started', { creator_id: creatorId, study_id: answer.study.id, ops: answer.ops.length });
            res.json(answer);
        } catch (err) {
            studiesFail(res, err, 'start_study');
        }
    });

    router.post('/studies/:id/stop', owner, async (req, res) => {
        const id = String(req.params['id'] ?? '');
        if (!UUID_RE.test(id)) {
            res.status(404).json({ error: 'That test does not exist.', code: 'NOT_FOUND' });
            return;
        }
        try {
            const creatorId = getTenantId(req);
            const answer = await stopStudy(ports(), creatorId, userId(req), id);
            log('info', 'ads.study_stopped', { creator_id: creatorId, study_id: answer.study.id, ops: answer.ops.length });
            res.json(answer);
        } catch (err) {
            studiesFail(res, err, 'stop_study');
        }
    });

    return router;
}
