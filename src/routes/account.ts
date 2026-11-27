/**
 * Your own account, under `/api/account` (U3, PR C). Above `resolveTenant` on purpose, like `/auth/password`: it is about the person, not
 * about a workspace, so a user holding no membership can still use it.
 *
 *   POST /sign-out-everywhere   → { message, token, expiresIn }
 *
 * "Sign out everywhere" is `users.token_version + 1`: every session the account holds, in every browser, stops working at the next
 * request (`requireLiveSession`). This request's own token dies with the rest, so a fresh one is minted with the new version and the caller
 * stays signed in HERE, exactly as `POST /auth/password` does. The shared dashboard password has no account: 400 `NO_USER_ACCOUNT`, never a
 * 401 (the client reads a 401 as "your session died" and would sign the person out for asking). Audit `user.sessions_revoke` with
 * `{ self_service: true }`; the token is in the answer and nowhere else.
 */
import { Router } from 'express';
import { queryOne } from '../db/query.js';
import { createSession, describeSessionLifetime } from '../middleware/auth.js';
import type { UserRow } from '../db/rows.js';
import { sendError } from '../services/errorCodes.js';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from '../services/audit.js';
import { describeError, log } from '../utils/log.js';

export const accountRouter = Router();

accountRouter.post('/sign-out-everywhere', async (req, res) => {
    try {
        const session = req.session!;
        if (!session.userId) {
            sendError(res, 400, 'NO_USER_ACCOUNT', {}, 'This session was created with the shared dashboard password, which is not a user account, so there is nothing to sign out of everywhere.');
            return;
        }
        const updated = await queryOne<Pick<UserRow, 'token_version'>>(
            'UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version',
            [session.userId]
        );
        if (!updated) {
            // The session names a user row that no longer exists: it genuinely is dead (the one 401 here, as in /auth/password).
            res.status(401).json({ error: 'Session expired or invalid — please login again.' });
            return;
        }
        const token = createSession({
            userId: session.userId,
            role: session.role,
            tenantId: session.tenantId,
            tokenVersion: updated.token_version,
            ...(session.exp !== undefined ? { exp: session.exp } : {}),
        });
        const actor = await actorFromSession(session);
        await writeAudit(actor, {
            action: AUDIT_ACTIONS.userSessionsRevoke,
            targetType: 'user',
            targetId: session.userId,
            detail: { self_service: true },
        });
        res.json({
            message: 'Every other session has been signed out.',
            token,
            expiresIn: describeSessionLifetime(session.exp !== undefined ? session.exp - Date.now() : undefined),
        });
    } catch (err) {
        log('error', 'api.sign_out_everywhere_failed', describeError(err));
        res.status(500).json({ error: 'Failed to sign out everywhere.' });
    }
});

export default accountRouter;
