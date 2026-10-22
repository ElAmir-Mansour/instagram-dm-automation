/**
 * The platform admin's Ads overview (phase A11, contracts/dashboard-api.md "Platform admin"), mounted at `/api/admin/ads` inside the admin
 * router, so `requirePlatformAdmin` has already run: anyone else gets the admin router's 404.
 *
 *   GET /tenants   { tenants: AdsTenantRow[] }   health, cap use as a percentage, open alerts; spend only for tenants that share it
 *
 * The enable switch, the ceiling (A1) and the legal sign-offs (A8) are their own routes under `/tenants/:id/…`.
 */
import { Router } from 'express';
import { listAdsTenants } from '../services/ads/tenantsOverview.js';
import { describeError, log } from '../utils/log.js';

export const adminAdsRouter = Router();

adminAdsRouter.get('/tenants', async (_req, res) => {
    try {
        res.json({ tenants: await listAdsTenants() });
    } catch (err) {
        log('error', 'admin.ads_tenants_failed', describeError(err));
        res.status(500).json({ error: 'Failed to read the ads overview.' });
    }
});
