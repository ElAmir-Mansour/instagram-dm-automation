/**
 * `/api/admin/onboarding/*`: what Operations shows about tenants getting set up (plan P31).
 *
 *   GET /funnel?days=30|90    { days, since, cohort, stages, steps, completed, abandoned, in_progress, medians, drafts, … }
 *
 * Mounted by `admin.ts` under its platform-admin gate, and gated again here, so that moving the mount cannot open it. Counts and
 * durations only: the funnel is built from `onboarding_events`, which holds no tenant's name, handle or answer
 * (`services/onboardingEvents.ts`), so there is nothing in the answer to redact. Read-only.
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { isMissingSchema } from '../services/health.js';
import { loadFunnel, parseFunnelWindow } from '../services/onboardingFunnel.js';
import { describeError, log } from '../utils/log.js';

const router = Router();

/** 404, never 403: a non-admin has no business learning that this surface exists. The same gate `admin.ts` puts above this router. */
router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.session?.role !== 'platform_admin') {
        res.status(404).json({ error: 'Not found.' });
        return;
    }
    next();
});

router.get('/funnel', async (req, res) => {
    const days = parseFunnelWindow(req.query.days);
    if (days === null) {
        res.status(400).json({ error: 'days must be 30 or 90.' });
        return;
    }
    try {
        res.set('Cache-Control', 'no-store').json(await loadFunnel(days));
    } catch (err) {
        if (isMissingSchema(err)) {
            res.status(503).json({ error: 'The database is missing migration v34 (src/config/migration_v34_onboarding.sql). Apply it with `npm run migrate`, then reload.' });
            return;
        }
        log('error', 'admin.onboarding_funnel_failed', describeError(err));
        res.status(500).json({ error: 'Failed to build the funnel.' });
    }
});

export default router;
