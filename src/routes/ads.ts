/**
 * Boost a published post with Meta ads, under `/api/ads` (docs/META_ADS_RESEARCH.md option 2; src/services/adBoosts.ts, metaAds.ts).
 * Mounted BELOW `resolveTenant` in api.ts, so every route acts as the session's tenant.
 *
 *   GET    /settings               the Settings card: account id, { set, last4 } of the token, the limits, this month's committed amount, and
 *                                  what Meta says about the account (name, currency, status, minimum daily budget) or why it could not say
 *   POST   /settings               any of { adAccountId, token, maxDailyBudget, monthlyCap } → the same
 *   GET    /boosts                 { boosts }
 *   GET    /eligibility            ?postId&platform → { eligible, reason }
 *   POST   /boosts                 { postId, platform, dailyBudget, days, objective, country, link? } → 201 { boost }, created PAUSED
 *   POST   /boosts/:id/activate    { confirm: true } → { boost }. THE ONLY ROUTE THAT STARTS SPENDING
 *   POST   /boosts/:id/pause       → { boost }
 *   POST   /boosts/:id/refresh     → { boost } (spend and insights read again)
 *   DELETE /boosts/:id             → { boost }
 *
 * **Tenant owner only, reads included** (`requireTenantRole('owner')`): this is the business's ad account and money. A refusal is
 * `{ error, code, field? }` (codes in adBoosts.ts `AdsErrorCode`); Meta's own refusals are 502 `META_ERROR` with `metaCode`. The token is
 * never in an answer, a log line or an audit row.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { actorFromSession, AUDIT_ACTIONS, writeAudit, type AuditAction } from '../services/audit.js';
import {
    activateBoost, AdsError, createBoost, deleteBoost, describeAdsSettings, eligibilityFor, listBoosts, parseSettingsInput, pauseBoost,
    readAdsSettings, refreshBoost, saveAdsSettings, type BoostView,
} from '../services/adBoosts.js';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { describeError, log } from '../utils/log.js';

export const adsRouter = Router();

const canAdminister = requireTenantRole('owner');

function fail(res: Response, err: unknown, what: string): void {
    if (err instanceof AdsError) {
        res.status(err.status).json({
            error: err.message, code: err.code,
            ...(err.field ? { field: err.field } : {}),
            ...(err.code === 'META_ERROR' ? { metaCode: err.metaCode ?? null } : {}),
        });
        return;
    }
    log('error', `ads.${what}_failed`, describeError(err));
    res.status(500).json({ error: `Failed to ${what.replace(/_/g, ' ')}.` });
}

async function audit(req: Request, action: AuditAction, boost: BoostView | null, detail: Record<string, unknown>): Promise<void> {
    await writeAudit(await actorFromSession(req.session), {
        action,
        targetType: boost ? 'ad_boost' : 'creator',
        targetId: boost ? boost.id : getTenantId(req),
        detail: boost
            ? { post_id: boost.postId, platform: boost.platform, daily_budget: boost.dailyBudget, days: boost.days, planned_total: boost.plannedTotal, currency: boost.currency, status: boost.status, campaign_id: boost.campaignId, ...detail }
            : detail,
    });
}

adsRouter.get('/settings', canAdminister, async (req, res) => {
    try {
        res.json(await describeAdsSettings(getTenantId(req)));
    } catch (err) {
        fail(res, err, 'read_ads_settings');
    }
});

adsRouter.post('/settings', canAdminister, async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const { settings } = await readAdsSettings(creatorId);
        const parsed = parseSettingsInput(req.body, settings);
        if (!parsed.ok) {
            res.status(400).json({ error: parsed.error, code: 'INVALID', field: parsed.field });
            return;
        }
        await saveAdsSettings(creatorId, parsed.value, settings, req.session?.userId ?? null);
        // Which settings changed, never the token's value.
        const changed = [...Object.keys(parsed.value.settings), ...(parsed.value.token !== undefined ? [parsed.value.token === null ? 'token_removed' : 'token'] : [])];
        await audit(req, AUDIT_ACTIONS.adsSettingsWrite, null, { changed });
        log('info', 'ads.settings_written', { creator_id: creatorId, changed });
        res.json(await describeAdsSettings(creatorId));
    } catch (err) {
        fail(res, err, 'save_ads_settings');
    }
});

adsRouter.get('/boosts', canAdminister, async (req, res) => {
    try {
        res.json({ boosts: await listBoosts(getTenantId(req)) });
    } catch (err) {
        fail(res, err, 'list_boosts');
    }
});

adsRouter.get('/eligibility', canAdminister, async (req, res) => {
    try {
        res.json(await eligibilityFor(getTenantId(req), req.query['postId'], req.query['platform']));
    } catch (err) {
        fail(res, err, 'check_eligibility');
    }
});

adsRouter.post('/boosts', canAdminister, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
        const boost = await createBoost(getTenantId(req), {
            postId: body['postId'], platform: body['platform'], dailyBudget: body['dailyBudget'], days: body['days'],
            objective: body['objective'], country: body['country'], link: body['link'],
        }, req.session?.userId ?? null);
        await audit(req, AUDIT_ACTIONS.adsBoostCreate, boost, { outcome: 'created_paused' });
        res.status(201).json({ boost });
    } catch (err) {
        if (err instanceof AdsError && err.code === 'META_ERROR') {
            // An attempt Meta refused is on record too: objects may have been created and deleted.
            await audit(req, AUDIT_ACTIONS.adsBoostCreate, null, { outcome: 'meta_refused', post_id: body['postId'] ?? null, meta_code: err.metaCode ?? null });
        }
        fail(res, err, 'create_boost');
    }
});

adsRouter.post('/boosts/:id/activate', canAdminister, async (req, res) => {
    // The dashboard's confirmation dialog sends this; a bare POST (a replayed request, a script) does not spend.
    if (req.body?.confirm !== true) {
        res.status(400).json({ error: 'Activating spends money: confirm it.', code: 'INVALID', field: 'confirm' });
        return;
    }
    try {
        const boost = await activateBoost(getTenantId(req), String(req.params['id']));
        await audit(req, AUDIT_ACTIONS.adsBoostActivate, boost, {});
        res.json({ boost });
    } catch (err) {
        fail(res, err, 'activate_boost');
    }
});

adsRouter.post('/boosts/:id/pause', canAdminister, async (req, res) => {
    try {
        const boost = await pauseBoost(getTenantId(req), String(req.params['id']));
        await audit(req, AUDIT_ACTIONS.adsBoostPause, boost, {});
        res.json({ boost });
    } catch (err) {
        fail(res, err, 'pause_boost');
    }
});

adsRouter.post('/boosts/:id/refresh', canAdminister, async (req, res) => {
    try {
        res.json({ boost: await refreshBoost(getTenantId(req), String(req.params['id'])) });
    } catch (err) {
        fail(res, err, 'refresh_boost');
    }
});

adsRouter.delete('/boosts/:id', canAdminister, async (req, res) => {
    try {
        const boost = await deleteBoost(getTenantId(req), String(req.params['id']));
        await audit(req, AUDIT_ACTIONS.adsBoostDelete, boost, {});
        res.json({ boost });
    } catch (err) {
        fail(res, err, 'delete_boost');
    }
});
