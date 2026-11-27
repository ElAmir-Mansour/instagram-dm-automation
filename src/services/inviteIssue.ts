/**
 * Making an invite link for a workspace and recording it: what the platform admin's invite routes and creating a workspace by name use, and (U3, PR C)
 * what the workspace owner's Team screen uses. Moved out of `src/routes/admin.ts` unchanged, so both callers owe a link the same checks, the same audit
 * row and the same shape; the only new thing is `opts.actor`, which says who made it for the funnel's event (`onboarding_events.actor`).
 */
import type { Request, Response } from 'express';
import { describeError, log } from '../utils/log.js';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from './audit.js';
import { getPublicBaseUrl } from './appSettings.js';
import { isMissingSchema, MIGRATION_HINT } from './health.js';
import {
    buildInviteUrl, createInvite, InviteError, shareFor,
    type AdminInvite, type CreatedInvite, type InvitePurpose,
} from './invites.js';
import { getOnboardingSettings, isInviteRole, type InviteLang, type OnboardingSettings } from './onboardingSettings.js';
import { recordEvent } from './onboardingEvents.js';

/** The origin this request arrived on: `getPublicBaseUrl`'s last resort, after the saved setting and PUBLIC_BASE_URL. */
export function requestOrigin(req: Request): string | null {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0]!.trim();
    const host = req.headers.host;
    return host ? `${proto}://${host}` : null;
}

/** An invite as the card renders it right after it is made: the listed fields, plus the one link and its message. */
export interface ShareableInvite extends AdminInvite {
    /** The link. Carries the token in its fragment, and exists only in the response of the call that made it. */
    url: string;
    whatsapp_text: string;
    lang: InviteLang;
}

export function shareable(created: CreatedInvite & { tenantName: string | null }, base: string, lang: InviteLang, settings: OnboardingSettings): ShareableInvite {
    const url = buildInviteUrl(base, created.token, lang);
    return {
        ...created.invite,
        url,
        lang,
        ...shareFor(settings, created.tenantName, url, lang, created.invite.purpose),
    };
}

/**
 * The 500 body for a failure that is not a refusal. A query that failed because the schema is behind the code names the migration
 * (the same sentence the admin routes give: a mystery becomes a one-line fix).
 */
function failWith(res: Response, err: unknown, event: string, message: string): void {
    log('error', event, describeError(err));
    if (isMissingSchema(err)) {
        res.status(500).json({ error: MIGRATION_HINT, migrationPending: true });
        return;
    }
    res.status(500).json({ error: message });
}

/** The refusals the invite service throws, as the status and body the dashboard reads; anything else is a 500. */
export function answerInviteFailure(res: Response, err: unknown, event: string, message: string): void {
    if (err instanceof InviteError) {
        res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
        return;
    }
    failWith(res, err, event, message);
}

/** What an audit row says about an invite: ids and facts, never the link. */
export function inviteAuditDetail(invite: AdminInvite, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        tenant_id: invite.creator_id,
        purpose: invite.purpose,
        membership_role: invite.role,
        email: invite.email,
        for_user_id: invite.user_id,
        expires_at: invite.expires_at,
        ...extra,
    };
}

export interface IssueInviteInput {
    creatorId: string;
    purpose?: InvitePurpose;
    role?: unknown;
    email?: unknown;
    userId?: string | null;
    ttlDays?: number | null;
    ttlHours?: number | null;
    lang: InviteLang;
}

/**
 * Make a link for a tenant and record it. Used by the invite route and by creating a tenant by name, which hands the operator
 * the link in the same response. The public base is resolved BEFORE the invite is written, so a deployment that cannot build
 * a link never leaves an invite behind that nobody can ever be given.
 *
 * `opts.actor` is who made it: `'admin'` (the default: the platform admin's routes) or `'tenant'` (the workspace owner's Team screen). It only
 * decides the actor of the funnel's `invite_created` event.
 */
export async function issueInvite(
    req: Request,
    input: IssueInviteInput,
    extra: Record<string, unknown> = {},
    opts: { actor?: 'admin' | 'tenant' } = {}
): Promise<ShareableInvite> {
    const settings = await getOnboardingSettings();
    const base = await getPublicBaseUrl(requestOrigin(req));
    if (!base) throw new InviteError(500, 'PUBLIC_URL_UNKNOWN', 'The public site address is not set (Settings → TikTok app → site address), so a link cannot be built.');
    const created = await createInvite({
        creatorId: input.creatorId,
        purpose: input.purpose,
        role: isInviteRole(input.role) ? input.role : null,
        email: typeof input.email === 'string' ? input.email : null,
        userId: input.userId ?? null,
        ttlDays: input.ttlDays ?? null,
        ttlHours: input.ttlHours ?? null,
        createdBy: req.session?.userId ?? null,
    }, settings);
    const actor = await actorFromSession(req.session);
    await writeAudit(actor, {
        action: AUDIT_ACTIONS.inviteCreate, targetType: 'invite', targetId: created.invite.id,
        detail: inviteAuditDetail(created.invite, { language: input.lang, ...extra }),
    });
    // The funnel's first stage (P31). A password reset is not onboarding, so only a join link counts.
    if (input.purpose !== 'reset') await recordEvent({ creatorId: input.creatorId, userId: req.session?.userId ?? null, actor: opts.actor ?? 'admin' }, 'invite_created');
    return shareable(created, base, input.lang, settings);
}
