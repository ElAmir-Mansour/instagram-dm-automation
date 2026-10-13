/**
 * The invite link's two public routes, `POST /api/invites/peek` and `POST /api/invites/accept` (docs/onboarding/02 §5).
 *
 * Public, like the TikTok callback and the Studio worker: the person opening a link has no session, so these are mounted in
 * `routes/api.ts` ABOVE `requireAuth`, and authenticate by the one thing they hold, the token. Everything that makes that safe
 * lives in `services/invites.ts` (a 32-byte token stored only as its sha256, single-use by one atomic claim, every unusable
 * link answering the same 410); what is here is the part that belongs to HTTP:
 *
 *   - **The same throttle as the login** (`services/loginThrottle.ts`, per IP). A link that does not open counts as a failed
 *     attempt, five are free and then each wait doubles; a flood of guesses is slowed before it reaches the database. The
 *     throttle is per instance (said in its own file), so the token's 256 bits are the real defence and this is the speed bump.
 *   - **`Cache-Control: no-store`** on every answer: a response about a private link belongs in no shared cache.
 *   - **A live session is read, never required.** A request that carries `Authorization: Bearer …` is told apart from an
 *     anonymous one: `peek` reports who is signed in so the page can offer "add this tenant to your account"; `accept` attaches
 *     that account instead of creating one. A session that is revoked, expired or for a disabled account counts as no session at
 *     all (a stale token left in `localStorage` is the usual case, and it must not stand between a new person and their link).
 *     A platform admin's session is refused outright (403 `ADMIN_SESSION`) *before* the link is touched, so the operator who is
 *     testing his own link does not spend it.
 *   - **Audit.** An accepted link is recorded as `invite.accept` with the person as the actor, and no token anywhere in it.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { verifySession } from '../middleware/auth.js';
import { queryOne } from '../db/query.js';
import type { UserRow } from '../db/rows.js';
import { acceptInvite, InviteError, peekInvite, type Viewer } from '../services/invites.js';
import { clientIp, loginRetryAfter, recordLoginFailure } from '../services/loginThrottle.js';
import { AUDIT_ACTIONS, writeAudit } from '../services/audit.js';
import { checkSessionValidity } from '../services/tenant.js';
import { describeError, log } from '../utils/log.js';

const router = Router();

/** The longest password a link will hash. scrypt's cost grows with the input, and the body limit is 15 MB. */
export const MAX_PASSWORD_LENGTH = 1024;

/**
 * Who is signed in, if anybody. A dead session is nobody.
 *
 * Reads the database for a user-backed session (is the account still active, has its `token_version` moved), the same rule
 * `requireLiveSession` applies. A platform admin, whether a user with that role or the legacy shared-password session (which
 * has no user row), is reported as `admin`.
 */
export async function readViewer(req: Request): Promise<Viewer | null> {
    const header = req.headers.authorization;
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!bearer) return null;
    const session = verifySession(bearer);
    if (!session) return null;
    if (!session.userId) return session.role === 'platform_admin' ? { kind: 'admin' } : null;

    const user = await queryOne<Pick<UserRow, 'id' | 'email' | 'role' | 'token_version' | 'is_active'>>(
        'SELECT id, email, role, token_version, is_active FROM users WHERE id = $1',
        [session.userId]
    );
    if (!user || !checkSessionValidity(session, user).ok) return null;
    if (user.role === 'platform_admin') return { kind: 'admin' };
    return { kind: 'user', userId: user.id, email: user.email, tokenVersion: user.token_version, ...(session.exp !== undefined ? { exp: session.exp } : {}) };
}

/** Answers 429 and returns true when this address must wait. */
function throttled(req: Request, res: Response): boolean {
    const wait = loginRetryAfter(clientIp(req));
    if (wait <= 0) return false;
    res.setHeader('Retry-After', String(wait));
    res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.`, code: 'RATE_LIMITED' });
    return true;
}

router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
});

router.post('/peek', async (req, res) => {
    if (throttled(req, res)) return;
    try {
        const peeked = await peekInvite((req.body ?? {}).token);
        if (!peeked) {
            recordLoginFailure(clientIp(req));
            res.status(410).json({ error: 'This link is no longer valid.', code: 'INVITE_INVALID' });
            return;
        }
        const viewer = await readViewer(req);
        res.json({
            ...peeked,
            viewer: viewer === null ? null : viewer.kind === 'admin'
                ? { signedIn: true, platformAdmin: true, email: null, emailMatches: null }
                : {
                    signedIn: true,
                    platformAdmin: false,
                    email: viewer.email,
                    // Null when the link is not for anyone in particular: nothing to match.
                    emailMatches: peeked.email ? peeked.email.toLowerCase() === viewer.email.toLowerCase() : null,
                },
        });
    } catch (err) {
        log('error', 'invites.peek_failed', describeError(err));
        res.status(500).json({ error: 'Could not open this link. Try again.' });
    }
});

router.post('/accept', async (req, res) => {
    const ip = clientIp(req);
    if (throttled(req, res)) return;
    try {
        const body = req.body ?? {};
        if (typeof body.password === 'string' && body.password.length > MAX_PASSWORD_LENGTH) {
            res.status(400).json({ error: `The password is too long: at most ${MAX_PASSWORD_LENGTH} characters.`, code: 'WEAK_PASSWORD' });
            return;
        }
        const viewer = await readViewer(req);
        // Only what the form is allowed to say: the tenant, the role and the account type come from the link, never from the body.
        const accepted = await acceptInvite({
            token: body.token, email: body.email, password: body.password, keepSignedIn: body.keepSignedIn, viewer,
        });

        await writeAudit({ userId: accepted.userId, email: accepted.email }, {
            action: AUDIT_ACTIONS.inviteAccept,
            targetType: 'invite',
            targetId: accepted.inviteId,
            detail: {
                tenant_id: accepted.tenantId,
                purpose: accepted.purpose,
                membership_role: accepted.role,
                created_user: accepted.created,
                attached_user: accepted.attached,
                already_member: accepted.alreadyMember,
                sessions_invalidated: accepted.sessionsInvalidated,
                keep_signed_in: accepted.keptSignedIn,
            },
        });

        res.status(201).json({
            token: accepted.session,
            expiresIn: accepted.expiresIn,
            userId: accepted.userId,
            role: 'user',
            tenantId: accepted.tenantId,
            tenantName: accepted.tenantName,
            email: accepted.email,
            purpose: accepted.purpose,
            created: accepted.created,
            attached: accepted.attached,
            alreadyMember: accepted.alreadyMember,
            onboarding: accepted.onboarding,
        });
    } catch (err) {
        if (err instanceof InviteError) {
            // Only a link that did not open is an "attempt". A weak password or a taken address is a person with a real link.
            if (err.code === 'INVITE_INVALID') recordLoginFailure(ip);
            res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
            return;
        }
        log('error', 'invites.accept_failed', describeError(err));
        res.status(500).json({ error: 'Could not use this link. Try again.' });
    }
});

export default router;
