/**
 * Growth & SEO hub routes, under `/api/growth` (GROWTH.md §3).
 *
 * Mounted BELOW `resolveTenant` in api.ts, so every route acts as the session's tenant, and every
 * route needs the operator role — like the Studio's, and as GROWTH.md specifies, because several of
 * them spend something: a Meta rate-limit budget (sync, competitors) or Gemini quota (coach,
 * keyword suggestions).
 *
 *   GET  /status                 permission states, what is missing, the exact fix, last sync
 *   POST /sync                   sync now; once per 10 minutes per tenant, else 429 + Retry-After
 *   GET  /overview?days=28&platform=all
 *   GET  /posts?days=90&sort=views&platform=&type=
 *   POST /coach
 *   GET  /settings · PUT /settings
 *   POST /keywords/suggest       { topic }
 *   GET  /competitors
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from '../services/audit.js';
import { runCoach } from '../services/growth/coach.js';
import { GROWTH_MIGRATION_HINT, GrowthError } from '../services/growth/common.js';
import { getCompetitors } from '../services/growth/competitors.js';
import { suggestKeywords } from '../services/growth/keywords.js';
import { getOverview, listPostInsights } from '../services/growth/overview.js';
import { getGrowthSettings, updateGrowthSettings } from '../services/growth/settings.js';
import { getGrowthStatus } from '../services/growth/status.js';
import { runSync } from '../services/growth/sync.js';
import { isMissingSchema } from '../services/health.js';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { describeError, log } from '../utils/log.js';

type Handler = (req: Request, res: Response) => Promise<void>;

/**
 * Every route's error handling, once: a GrowthError is the answer as-is (a 429 also sets
 * Retry-After), a missing v22 table is a 503 naming the migration, anything else a logged 500.
 */
export function handle(event: string, fallback: string, fn: Handler) {
    return async (req: Request, res: Response): Promise<void> => {
        try {
            await fn(req, res);
        } catch (err) {
            if (err instanceof GrowthError) {
                const retryAfter = err.extra?.retryAfter;
                if (err.status === 429 && typeof retryAfter === 'number') res.setHeader('Retry-After', String(retryAfter));
                res.status(err.status).json({ error: err.message, ...(err.extra ?? {}) });
                return;
            }
            if (isMissingSchema(err)) {
                log('error', 'growth.schema_missing', describeError(err));
                res.status(503).json({ error: GROWTH_MIGRATION_HINT });
                return;
            }
            log('error', event, describeError(err));
            res.status(500).json({ error: fallback });
        }
    };
}

export const growthRouter = Router();

growthRouter.use(requireTenantRole('operator'));

growthRouter.get('/status', handle('growth.status_failed', 'Failed to read the Growth status.', async (req, res) => {
    res.json(await getGrowthStatus(getTenantId(req)));
}));

growthRouter.post('/sync', handle('growth.sync_failed', 'Failed to sync the insights.', async (req, res) => {
    res.json(await runSync(getTenantId(req)));
}));

growthRouter.get('/overview', handle('growth.overview_failed', 'Failed to build the overview.', async (req, res) => {
    res.json(await getOverview(getTenantId(req), { days: req.query.days, platform: req.query.platform }));
}));

growthRouter.get('/posts', handle('growth.posts_failed', 'Failed to list the posts.', async (req, res) => {
    res.json(await listPostInsights(getTenantId(req), {
        days: req.query.days, sort: req.query.sort, platform: req.query.platform, type: req.query.type,
    }));
}));

growthRouter.post('/coach', handle('growth.coach_route_failed', 'Failed to run the coach.', async (req, res) => {
    res.json(await runCoach(getTenantId(req)));
}));

growthRouter.get('/settings', handle('growth.settings_read_failed', 'Failed to read the Growth settings.', async (req, res) => {
    res.json({ settings: await getGrowthSettings(getTenantId(req)) });
}));

growthRouter.put('/settings', handle('growth.settings_save_failed', 'Failed to save the Growth settings.', async (req, res) => {
    const creatorId = getTenantId(req);
    const settings = await updateGrowthSettings(creatorId, req.body);
    await writeAudit(await actorFromSession(req.session), {
        action: AUDIT_ACTIONS.growthSettingsWrite, targetType: 'creator', targetId: creatorId,
        detail: { keys: Object.keys(req.body ?? {}) },
    });
    res.json({ settings });
}));

growthRouter.post('/keywords/suggest', handle('growth.keywords_route_failed', 'Failed to suggest keywords.', async (req, res) => {
    res.json(await suggestKeywords(getTenantId(req), req.body));
}));

growthRouter.get('/competitors', handle('growth.competitors_failed', 'Failed to read the competitors.', async (req, res) => {
    res.json(await getCompetitors(getTenantId(req)));
}));
