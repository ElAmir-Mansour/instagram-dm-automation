/**
 * The go-live checklist, under `/api/golive` (U3, SA-12; docs/specs/007-company-shell §7). Mounted BELOW `resolveTenant` in api.ts: the
 * workspace is the session's own (`getTenantId`), never a body's.
 *
 *   GET    /          the checklist, its progress and the activation numbers; `{ show: false }` and nothing else when it is not to be shown
 *                     (the platform owner's workspace, a workspace with no onboarding, anyone but the workspace owner, hidden, or live for 3 days)
 *   POST   /dismiss   owner   hides it           -> { dismissedAt }
 *   DELETE /dismiss   owner   shows it again     -> { dismissedAt: null }
 *
 * The read is open to any member and answers `{ show: false }` to all but an owner, so the dashboard asks once and draws what it is given.
 */
import { Router } from 'express';
import { recordEvent } from '../services/onboardingEvents.js';
import { readGoLive, setDismissed } from '../services/goLive.js';
import { getTenantId, requireTenantRole, tenantRoleAllows } from '../services/tenant.js';
import { describeError, log } from '../utils/log.js';

export const goLiveRouter = Router();

const canAdminister = requireTenantRole('owner');

goLiveRouter.get('/', requireTenantRole('viewer'), async (req, res) => {
    try {
        res.json(await readGoLive({
            tenantId: getTenantId(req),
            isWorkspaceOwner: req.tenantRole !== undefined && tenantRoleAllows(req.tenantRole, 'owner'),
            userId: req.session?.userId ?? null,
        }));
    } catch (err) {
        log('error', 'golive.read_failed', describeError(err));
        res.status(500).json({ error: 'Something went wrong. Try again.' });
    }
});

goLiveRouter.post('/dismiss', canAdminister, async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const userId = req.session?.userId ?? null;
        const dismissedAt = await setDismissed(tenantId, true, userId);
        await recordEvent({ creatorId: tenantId, userId, actor: 'tenant' }, 'golive_dismissed');
        res.json({ dismissedAt });
    } catch (err) {
        log('error', 'golive.dismiss_failed', describeError(err));
        res.status(500).json({ error: 'Something went wrong. Try again.' });
    }
});

goLiveRouter.delete('/dismiss', canAdminister, async (req, res) => {
    try {
        res.json({ dismissedAt: await setDismissed(getTenantId(req), false, req.session?.userId ?? null) });
    } catch (err) {
        log('error', 'golive.undismiss_failed', describeError(err));
        res.status(500).json({ error: 'Something went wrong. Try again.' });
    }
});
