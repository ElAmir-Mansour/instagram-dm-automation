/**
 * Team: the workspace owner's own people (U3, CO-2), under `/api/team`. Mounted BELOW `resolveTenant`, so every route acts as the session's
 * workspace (I6: the tenant is `getTenantId(req)`, never a body or a path), and **every route is the owner's** (`requireTenantRole('owner')`,
 * reads included: who is in the workspace and who was invited is not for an operator or a viewer). A platform admin acting in a workspace
 * is an owner of it.
 *
 *   GET    /                              { members, invites }     the people and the newest 20 invites (never a link)
 *   POST   /invites                       { role, email?, lang? }  → 201 { invite }   the one link, given once
 *   POST   /invites/:id/regenerate        { lang? }                → 201 { invite, previous_invite_id }
 *   DELETE /invites/:id                                            → { revoked, already_revoked }
 *   PATCH  /members/:userId               { role }                 → { userId, role }
 *   DELETE /members/:userId                                        → { userId, removed, you }
 *   POST   /members/:userId/reset-link    { lang? }                → 201 { invite }   a `purpose: 'reset'` link (SA-06)
 *
 * The rules (the last owner stays; a platform admin is read-only; a stranger is a 404) are `services/team.ts`. An invite that belongs to
 * ANOTHER workspace is a 404 here, like one that does not exist: the scope is in the SQL (`revokeInvite` / `regenerateInvite`'s `scope`).
 *
 * The audit rows are the ones the admin screen writes, with `via: 'team'`: `invite.create`, `invite.regenerate`, `invite.revoke`,
 * `membership.role_change`, `membership.revoke`. A link is never in an answer except the one that made it, and never in a log or an audit row.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from '../services/audit.js';
import { getPublicBaseUrl } from '../services/appSettings.js';
import {
    buildInviteUrl, createInvite, InviteError, listInvites, regenerateInvite, revokeInvite, shareFor, tenantLanguage,
    type AdminInvite, type CreatedInvite,
} from '../services/invites.js';
import { recordEvent } from '../services/onboardingEvents.js';
import { getOnboardingSettings, isInviteLang, isInviteRole, type InviteLang, type OnboardingSettings } from '../services/onboardingSettings.js';
import { assertResettable, changeRole, listMembers, removeMember, TeamError } from '../services/team.js';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { describeError, log } from '../utils/log.js';

export const teamRouter = Router();

/** Every route is the workspace owner's: see the top of the file. */
teamRouter.use(requireTenantRole('owner'));

// ─── Stand-ins until PR A (src/services/inviteIssue.ts, errorCodes.ts, audit.ts) ────────────────────────────────────────────────────
// until PR A: `issueInvite`, `shareable`, `answerInviteFailure`, `requestOrigin` and `inviteAuditDetail` are private to routes/admin.ts today. PR A
// moves them, unchanged, to services/inviteIssue.ts (with `opts.actor`); then this block is deleted and the imports come from there. The team
// codes below go to ERROR_CODES (and errors.<CODE> in both dictionaries) with A's U3 codes; until then they are sent flat, as the routes
// without a registry entry always were, and the Team screen words them itself (`settings.team.err.<CODE>`).

const AUDIT_MEMBERSHIP_ROLE_CHANGE = 'membership.role_change'; // until PR A: AUDIT_ACTIONS.membershipRoleChange

function requestOrigin(req: Request): string | null {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0]!.trim();
    const host = req.headers.host;
    return host ? `${proto}://${host}` : null;
}

interface ShareableInvite extends AdminInvite { url: string; whatsapp_text: string; lang: InviteLang }

function shareable(created: CreatedInvite & { tenantName: string | null }, base: string, lang: InviteLang, settings: OnboardingSettings): ShareableInvite {
    const url = buildInviteUrl(base, created.token, lang);
    return { ...created.invite, url, lang, ...shareFor(settings, created.tenantName, url, lang, created.invite.purpose) };
}

function inviteAuditDetail(invite: AdminInvite, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        tenant_id: invite.creator_id, purpose: invite.purpose, membership_role: invite.role, email: invite.email,
        for_user_id: invite.user_id, expires_at: invite.expires_at, ...extra,
    };
}

async function audit(req: Request, action: string, targetType: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    const actor = await actorFromSession(req.session);
    await writeAudit(actor, { action, targetType, targetId, detail });
}

/** The public address a link is built on, resolved BEFORE anything is written: a deployment that cannot build one never leaves an invite nobody can be given. */
async function linkBase(req: Request): Promise<string> {
    const base = await getPublicBaseUrl(requestOrigin(req));
    if (!base) throw new InviteError(500, 'PUBLIC_URL_UNKNOWN', 'The public site address is not set, so a link cannot be built.');
    return base;
}

/** `{ error, message, code }`: the flat envelope (errorCodes.ts), for the refusals PR A registers. */
function refuse(res: Response, status: number, code: string, message: string): void {
    res.status(status).json({ error: message, message, code, params: {} });
}

function answerFailure(res: Response, err: unknown, event: string, message: string): void {
    if (err instanceof TeamError) {
        refuse(res, err.status, err.code, err.message);
        return;
    }
    if (err instanceof InviteError) {
        res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
        return;
    }
    log('error', event, describeError(err));
    res.status(500).json({ error: message });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `lang` from a body: absent means the workspace's own language; anything else must be `ar` or `en`. */
function readLang(raw: unknown): { ok: true; lang: InviteLang | null } | { ok: false } {
    if (raw === undefined || raw === null || raw === '') return { ok: true, lang: null };
    return isInviteLang(raw) ? { ok: true, lang: raw } : { ok: false };
}

// ─── Reading ───────────────────────────────────────────────────────────────────────────────────────

teamRouter.get('/', async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const [members, invites] = await Promise.all([listMembers(creatorId, req.session?.userId ?? null), listInvites(creatorId)]);
        res.json({ members, invites });
    } catch (err) {
        answerFailure(res, err, 'team.read_failed', 'Failed to read the team.');
    }
});

// ─── Invites ───────────────────────────────────────────────────────────────────────────────────────

teamRouter.post('/invites', async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const body = req.body ?? {};
        if (!isInviteRole(body.role)) {
            refuse(res, 400, 'ROLE_INVALID', 'role must be owner, operator or viewer.');
            return;
        }
        const lang = readLang(body.lang);
        if (!lang.ok) {
            res.status(400).json({ error: 'lang must be "ar" or "en".' });
            return;
        }
        const settings = await getOnboardingSettings();
        const base = await linkBase(req);
        const created = await createInvite({
            creatorId, purpose: 'join', role: body.role, email: typeof body.email === 'string' ? body.email : null,
            createdBy: req.session?.userId ?? null,
        }, settings);
        const language = lang.lang ?? await tenantLanguage(creatorId);
        await audit(req, AUDIT_ACTIONS.inviteCreate, 'invite', created.invite.id, inviteAuditDetail(created.invite, { language, via: 'team' }));
        await recordEvent({ creatorId, userId: req.session?.userId ?? null, actor: 'tenant' }, 'invite_created');
        res.status(201).json({ invite: shareable(created, base, language, settings) });
    } catch (err) {
        answerFailure(res, err, 'team.invite_create_failed', 'Failed to create the invite.');
    }
});

teamRouter.post('/invites/:id/regenerate', async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const id = String(req.params.id);
        if (!UUID.test(id)) {
            res.status(404).json({ error: 'Invite not found.' });
            return;
        }
        const lang = readLang((req.body ?? {}).lang);
        if (!lang.ok) {
            res.status(400).json({ error: 'lang must be "ar" or "en".' });
            return;
        }
        const settings = await getOnboardingSettings();
        const base = await linkBase(req);
        const regenerated = await regenerateInvite(id, req.session?.userId ?? null, settings, { creatorId });
        const language = lang.lang ?? await tenantLanguage(creatorId);
        await audit(req, AUDIT_ACTIONS.inviteRegenerate, 'invite', regenerated.invite.id, inviteAuditDetail(regenerated.invite, {
            previous_invite_id: regenerated.previousId, language, via: 'team',
        }));
        if (regenerated.invite.purpose === 'join') await recordEvent({ creatorId, userId: req.session?.userId ?? null, actor: 'tenant' }, 'invite_created');
        res.status(201).json({ invite: shareable(regenerated, base, language, settings), previous_invite_id: regenerated.previousId });
    } catch (err) {
        answerFailure(res, err, 'team.invite_regenerate_failed', 'Failed to regenerate the invite.');
    }
});

teamRouter.delete('/invites/:id', async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const id = String(req.params.id);
        if (!UUID.test(id)) {
            res.status(404).json({ error: 'Invite not found.' });
            return;
        }
        const outcome = await revokeInvite(id, undefined, { creatorId });
        if (outcome.changed) {
            await audit(req, AUDIT_ACTIONS.inviteRevoke, 'invite', outcome.id, { tenant_id: outcome.creatorId, purpose: outcome.purpose, via: 'team' });
        }
        res.json({ revoked: true, already_revoked: !outcome.changed, id: outcome.id });
    } catch (err) {
        answerFailure(res, err, 'team.invite_revoke_failed', 'Failed to revoke the invite.');
    }
});

// ─── Members ───────────────────────────────────────────────────────────────────────────────────────

teamRouter.patch('/members/:userId', async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const userId = String(req.params.userId);
        if (!UUID.test(userId)) {
            refuse(res, 404, 'MEMBER_NOT_FOUND', 'That person is not a member of this workspace.');
            return;
        }
        const change = await changeRole(creatorId, userId, (req.body ?? {}).role);
        if (change.from !== change.to) {
            await audit(req, AUDIT_MEMBERSHIP_ROLE_CHANGE, 'membership', `${userId}:${creatorId}`, {
                user_id: userId, creator_id: creatorId, from: change.from, to: change.to, via: 'team',
            });
        }
        res.json({ userId, role: change.to });
    } catch (err) {
        answerFailure(res, err, 'team.role_change_failed', 'Failed to change the role.');
    }
});

teamRouter.delete('/members/:userId', async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const userId = String(req.params.userId);
        if (!UUID.test(userId)) {
            refuse(res, 404, 'MEMBER_NOT_FOUND', 'That person is not a member of this workspace.');
            return;
        }
        const removal = await removeMember(creatorId, userId);
        await audit(req, AUDIT_ACTIONS.membershipRevoke, 'membership', `${userId}:${creatorId}`, {
            user_id: userId, creator_id: creatorId, membership_role: removal.role, via: 'team',
        });
        res.json({ userId, removed: true, you: userId === (req.session?.userId ?? null) });
    } catch (err) {
        answerFailure(res, err, 'team.remove_failed', 'Failed to remove the person.');
    }
});

teamRouter.post('/members/:userId/reset-link', async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const userId = String(req.params.userId);
        if (!UUID.test(userId)) {
            refuse(res, 404, 'MEMBER_NOT_FOUND', 'That person is not a member of this workspace.');
            return;
        }
        const lang = readLang((req.body ?? {}).lang);
        if (!lang.ok) {
            res.status(400).json({ error: 'lang must be "ar" or "en".' });
            return;
        }
        // Members of THIS workspace only, and never the account manager (createInvite refuses an admin too: this says which refusal it is).
        await assertResettable(creatorId, userId);
        const settings = await getOnboardingSettings();
        const base = await linkBase(req);
        const created = await createInvite({ creatorId, purpose: 'reset', userId, createdBy: req.session?.userId ?? null }, settings);
        const language = lang.lang ?? await tenantLanguage(creatorId);
        await audit(req, AUDIT_ACTIONS.inviteCreate, 'invite', created.invite.id, inviteAuditDetail(created.invite, { language, via: 'team' }));
        res.status(201).json({ invite: shareable(created, base, language, settings) });
    } catch (err) {
        answerFailure(res, err, 'team.reset_link_failed', 'Failed to create the reset link.');
    }
});

export default teamRouter;
