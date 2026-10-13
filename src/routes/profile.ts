/**
 * The Creator Profile's routes, under `/api/profile` (docs/onboarding/01 §4; FLOWS.md §4.7).
 *
 * Mounted BELOW `resolveTenant` in api.ts, so every route acts as the session's tenant.
 *
 *   GET   /                { profile, version, stored, activationMissing }    operator or owner
 *   GET   /campaign-seeds  { seeds, source }  what the bulk import seeds from  operator or owner
 *   PATCH /                { version, patch }  →  the same, after the change  owner only
 *
 * `version` is what makes a write safe: a PATCH names the version it was written against and is refused with 409
 * (and `currentVersion` in the body) when the profile has moved on. `stored` is false for a tenant whose profile is
 * still the virtual one its settings describe (`version` is then null, and a PATCH sends null back).
 *
 * The answers to a refusal are `{ error, code, … }`: `PROFILE_INVALID` 400 with `problems`, `PROFILE_VERSION_CONFLICT`
 * and `PROFILE_NEWER_SCHEMA` 409 with `currentVersion`, `PROFILE_STORAGE_MISSING` 503. A change is audited as
 * `profile.write` with the names of the sections it changed and never their values; a request that changed nothing
 * writes nothing and is not audited.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from '../services/audit.js';
import { readCampaignSeeds } from '../services/profile/campaignSeeds.js';
import { patchProfile, readProfileState } from '../services/profile/patch.js';
import { ProfileError } from '../services/profile/store.js';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { describeError, log } from '../utils/log.js';

type Handler = (req: Request, res: Response) => Promise<void>;

/** Every route's error handling, once: a `ProfileError` is the answer as it is, anything else a logged 500. */
function handle(event: string, fallback: string, fn: Handler) {
    return async (req: Request, res: Response): Promise<void> => {
        try {
            await fn(req, res);
        } catch (err) {
            if (err instanceof ProfileError) {
                const { problems, currentVersion } = err.detail;
                res.status(err.status).json({
                    error: err.message,
                    code: err.code,
                    ...(problems ? { problems } : {}),
                    // A conflict always says which version to reload: null when the tenant has no stored profile.
                    ...(currentVersion !== undefined || err.code === 'PROFILE_VERSION_CONFLICT' ? { currentVersion: currentVersion ?? null } : {}),
                });
                return;
            }
            log('error', event, describeError(err));
            res.status(500).json({ error: fallback });
        }
    };
}

export const profileRouter = Router();

/**
 * Reading the profile is operator-level, like every read of the Studio's and Growth's settings (studio.ts, growth.ts): it holds
 * the offers, the DM answers and the hand-off rules, which are configuration, and a `viewer` membership sees the account's
 * numbers and not how it is run. Changing it changes what every agent writes in the creator's name: the owner's call (01 §4).
 */
const canOperate = requireTenantRole('operator');
const canEdit = requireTenantRole('owner');

profileRouter.get('/', canOperate, handle('profile.read_failed', 'Failed to read the profile.', async (req, res) => {
    res.json(await readProfileState(getTenantId(req)));
}));

/**
 * What the Campaigns screen's bulk import starts each imported row from (`campaignSeeds.ts`, P13, P15): `{ seeds, source, fallback }`, one
 * seed per offer of this tenant that has a campaign. Operator-level like the profile itself, and for the same reason it is
 * not a `viewer`'s: it is the wording of the replies this account sends. Reads only; nothing here writes or is audited.
 */
profileRouter.get('/campaign-seeds', canOperate, handle('profile.campaign_seeds_failed', 'Failed to read the campaign seeds.', async (req, res) => {
    res.json(await readCampaignSeeds(getTenantId(req)));
}));

profileRouter.patch('/', canEdit, handle('profile.save_failed', 'Failed to save the profile.', async (req, res) => {
    const creatorId = getTenantId(req);
    const { changed, ...state } = await patchProfile(creatorId, req.body, { userId: req.session?.userId ?? null });
    if (changed.length > 0) {
        // Section names only: what the profile says is never written to the audit trail.
        await writeAudit(await actorFromSession(req.session), {
            action: AUDIT_ACTIONS.profileWrite, targetType: 'creator', targetId: creatorId, detail: { paths: changed, version: state.version },
        });
    }
    res.json(state);
}));
