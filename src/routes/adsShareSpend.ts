/**
 * A client's own side of managed ads (phase A11), mounted in `adsRouter` after its ADS_DISABLED gate, so the session's tenant is resolved:
 *
 *   GET  /settings/share-spend   (any member)  { shareSpend, ceiling, managed }
 *   POST /settings/share-spend   (owner)       { on: boolean } → the same
 *
 * `shareSpend` is the tenant owner's choice to let the platform admin see its ad spend (`ads.share_spend.<tenant>`, default off). The
 * admin overview shows cap use as a percentage either way, and amounts only when this is on. `ceiling` is the most the platform admin
 * allows this tenant's limits to be; `managed` is false for the platform owner's own tenant, which has no ceiling and nobody to share with.
 */
import { Router } from 'express';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from '../services/audit.js';
import { getSetting, setSetting, tenantSettingKey, TENANT_SETTING_PREFIXES } from '../services/appSettings.js';
import { needsCeiling, readCeiling } from '../services/ads/settings.js';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { describeError, log } from '../utils/log.js';

export const adsShareSpendRouter = Router();

async function view(creatorId: string) {
    const [raw, ceiling, managed] = await Promise.all([
        getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsShareSpend, creatorId)),
        readCeiling(creatorId),
        needsCeiling(creatorId),
    ]);
    return { shareSpend: raw === 'true', ceiling, managed };
}

adsShareSpendRouter.get('/settings/share-spend', async (req, res) => {
    try {
        res.json(await view(getTenantId(req)));
    } catch (err) {
        log('error', 'ads.share_spend_read_failed', describeError(err));
        res.status(500).json({ error: 'Failed to read the sharing setting.' });
    }
});

adsShareSpendRouter.post('/settings/share-spend', requireTenantRole('owner'), async (req, res) => {
    const on = (req.body as Record<string, unknown> | undefined)?.['on'];
    if (typeof on !== 'boolean') {
        res.status(400).json({ error: 'on is true or false.', code: 'INVALID', field: 'on' });
        return;
    }
    try {
        const creatorId = getTenantId(req);
        const actor = await actorFromSession(req.session);
        await setSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsShareSpend, creatorId), on ? 'true' : null, req.session?.userId ?? null);
        await writeAudit(actor, { action: AUDIT_ACTIONS.adsShareSpendChanged, targetType: 'creator', targetId: creatorId, detail: { on } });
        res.json(await view(creatorId));
    } catch (err) {
        log('error', 'ads.share_spend_write_failed', describeError(err));
        res.status(500).json({ error: 'Failed to save the sharing setting.' });
    }
});
