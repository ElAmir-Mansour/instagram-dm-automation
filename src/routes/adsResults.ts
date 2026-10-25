/**
 * `GET /api/ads/results` (A6, Results history): per-day results from the stored copy, for the Results tab, the Results screen's ad rows and
 * anything else that charts ads. Mounted inside `adsRouter`, so the ADS_DISABLED gate runs first and the tenant is the session's.
 *
 *   GET /results   ?level=account|campaign|adset|ad &ids=<Meta ids> &from=YYYY-MM-DD &to=YYYY-MM-DD &breakdown=country|placement
 *                  → the answer of src/services/ads/results.ts `getAdsResults`. Any member may read it (viewer and up).
 *
 * Postgres only, never Meta (FR-015): opening the tab costs none of the ad account's Limited-tier points. A bad field is 400 `INVALID`
 * with `field`; anything else is logged and answered 500 without the database's own message.
 */
import { Router } from 'express';
import { getAdsResults, ResultsQueryError } from '../services/ads/results.js';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { describeError, log } from '../utils/log.js';

export const adsResultsRouter = Router();

adsResultsRouter.get('/results', requireTenantRole('viewer'), async (req, res) => {
    try {
        res.json(await getAdsResults(getTenantId(req), req.query));
    } catch (err) {
        if (err instanceof ResultsQueryError) {
            res.status(400).json({ error: err.message, code: 'INVALID', field: err.field });
            return;
        }
        log('error', 'ads.read_results_failed', describeError(err));
        res.status(500).json({ error: 'Failed to read the ads results.' });
    }
});
