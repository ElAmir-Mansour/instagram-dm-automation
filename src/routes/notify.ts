/**
 * How each person is told, under `/api/notify` (U3, SA-11; docs/specs/007-company-shell §6). Mounted BELOW `resolveTenant` in api.ts: the
 * workspace is always the session's (`getTenantId`), never a body's or a path's.
 *
 *   GET    /me                 viewer+   { hasAccount, platformAdmin, botReady, telegram: { linked, linkedAt, name, paused } | null, covers }
 *   POST   /telegram/link      viewer+   { url, expiresAt }       the link the person opens (needs their own account)
 *   POST   /telegram/confirm   viewer+   { code } -> { linked: true, name } | { linked: false } (keep asking) | 410 TELEGRAM_LINK_EXPIRED
 *   PATCH  /me                 viewer+   { paused } -> the GET shape
 *   DELETE /telegram           viewer+   { linked: false }        deletes the chat id and the name
 *   GET    /routing            owner     { botReady, defaults, members, handoff, hotLeads }
 *   PUT    /routing            owner     { handoff, hotLeads } -> the GET shape; 400 ROUTING_INVALID for a non-member
 *
 * What is never in an answer, a log line or an audit row: the bot token and any chat id. A person is told THEIR OWN linked state and
 * nothing of anybody else's beyond "linked or not" in the owner's routing table.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from '../services/audit.js';
import { sendError } from '../services/errorCodes.js';
import { readTelegramSettings } from '../services/notify.js';
import { coveredBy, readTeamNotify, writeRouting, type Routing } from '../services/notifyPeople.js';
import { confirmLink, setPaused, startLink, TelegramLinkError, unlink } from '../services/telegramLink.js';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { describeError, log } from '../utils/log.js';

export const notifyRouter = Router();

/** Everyone in the workspace sees and changes their OWN notices; only the owner chooses who covers what. */
const anyMember = requireTenantRole('viewer');
const canAdminister = requireTenantRole('owner');

const REFUSALS = {
    TELEGRAM_BOT_MISSING: { status: 409, message: 'Telegram alerts are not set up on this platform yet.' },
    TELEGRAM_UNREACHABLE: { status: 502, message: 'Telegram did not answer. Try again in a minute.' },
    TELEGRAM_LINK_EXPIRED: { status: 410, message: 'That link has expired. Make a new one.' },
} as const;

/** The signed-in person's own account, or null for the shared-password session (it has no user row, so nothing to link). */
function userOf(req: Request): string | null {
    return req.session?.userId ?? null;
}

function handle(res: Response, event: string, err: unknown): void {
    if (err instanceof TelegramLinkError) {
        const r = REFUSALS[err.code];
        sendError(res, r.status, err.code, {}, r.message);
        return;
    }
    log('error', event, describeError(err));
    res.status(500).json({ error: 'Something went wrong. Try again.' });
}

/** The answer of `GET /me`: this person's own state. `telegram` is null for a session with no account of its own. */
async function mine(req: Request): Promise<Record<string, unknown>> {
    const tenantId = getTenantId(req);
    const userId = userOf(req);
    const settings = await readTelegramSettings();
    const platformAdmin = req.session?.role === 'platform_admin';
    const base = { hasAccount: userId !== null, platformAdmin, botReady: Boolean(settings.token) };
    if (userId === null) return { ...base, telegram: null, covers: { handoff: false, hotLeads: false } };

    const { members, routing } = await readTeamNotify(tenantId);
    const me = members.find((m) => m.userId === userId);
    const t = me?.notify.telegram ?? null;
    return {
        ...base,
        telegram: { linked: Boolean(t), linkedAt: t?.linkedAt || null, name: t?.name || null, paused: t?.paused ?? false },
        // A platform admin is not in `members`: the account manager has the platform's own alerts, so nothing here covers him.
        covers: {
            handoff: coveredBy('handoff', members, routing).some((m) => m.userId === userId),
            hotLeads: coveredBy('hotLeads', members, routing).some((m) => m.userId === userId),
        },
    };
}

notifyRouter.get('/me', anyMember, async (req, res) => {
    try {
        res.json(await mine(req));
    } catch (err) {
        handle(res, 'notify.me_failed', err);
    }
});

notifyRouter.post('/telegram/link', anyMember, async (req, res) => {
    const userId = userOf(req);
    if (userId === null) {
        sendError(res, 400, 'NO_USER_ACCOUNT', {}, 'Sign in with your own account to get notices on Telegram.');
        return;
    }
    try {
        res.json(await startLink({ creatorId: getTenantId(req), userId }));
    } catch (err) {
        handle(res, 'notify.link_failed', err);
    }
});

notifyRouter.post('/telegram/confirm', anyMember, async (req, res) => {
    const userId = userOf(req);
    if (userId === null) {
        sendError(res, 400, 'NO_USER_ACCOUNT', {}, 'Sign in with your own account to get notices on Telegram.');
        return;
    }
    try {
        res.json(await confirmLink({ creatorId: getTenantId(req), userId }, (req.body as { code?: unknown } | undefined)?.code, req.session));
    } catch (err) {
        handle(res, 'notify.confirm_failed', err);
    }
});

notifyRouter.patch('/me', anyMember, async (req, res) => {
    const userId = userOf(req);
    if (userId === null) {
        sendError(res, 400, 'NO_USER_ACCOUNT', {}, 'Sign in with your own account to get notices on Telegram.');
        return;
    }
    const paused = (req.body as { paused?: unknown } | undefined)?.paused;
    if (typeof paused !== 'boolean') {
        res.status(400).json({ error: 'paused must be true or false.' });
        return;
    }
    try {
        await setPaused({ creatorId: getTenantId(req), userId }, paused);
        res.json(await mine(req));
    } catch (err) {
        handle(res, 'notify.pause_failed', err);
    }
});

notifyRouter.delete('/telegram', anyMember, async (req, res) => {
    const userId = userOf(req);
    if (userId === null) {
        sendError(res, 400, 'NO_USER_ACCOUNT', {}, 'Sign in with your own account to get notices on Telegram.');
        return;
    }
    try {
        await unlink({ creatorId: getTenantId(req), userId }, req.session);
        res.json({ linked: false });
    } catch (err) {
        handle(res, 'notify.unlink_failed', err);
    }
});

// ─── The workspace's routing (owner) ─────────────────────────────────────────────────────────────────────

/** The routing table: who is in the workspace, who covers what (the default when nothing was chosen), and whether the bot exists. */
async function routingView(tenantId: string): Promise<Record<string, unknown>> {
    const settings = await readTelegramSettings();
    const { members, routing } = await readTeamNotify(tenantId);
    return {
        botReady: Boolean(settings.token),
        defaults: routing === null,
        members: members.map((m) => ({ userId: m.userId, email: m.email, role: m.role, telegramLinked: Boolean(m.notify.telegram) })),
        handoff: coveredBy('handoff', members, routing).map((m) => m.userId),
        hotLeads: coveredBy('hotLeads', members, routing).map((m) => m.userId),
    };
}

notifyRouter.get('/routing', canAdminister, async (req, res) => {
    try {
        res.json(await routingView(getTenantId(req)));
    } catch (err) {
        handle(res, 'notify.routing_read_failed', err);
    }
});

notifyRouter.put('/routing', canAdminister, async (req, res) => {
    const body = (req.body ?? {}) as { handoff?: unknown; hotLeads?: unknown };
    const lists: Routing = { v: 1, handoff: [], hotLeads: [] };
    for (const field of ['handoff', 'hotLeads'] as const) {
        const raw = body[field];
        if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
            sendError(res, 400, 'ROUTING_INVALID', { userId: '' }, 'Choose people from this workspace.');
            return;
        }
        lists[field] = [...new Set(raw as string[])];
    }
    try {
        const tenantId = getTenantId(req);
        const { members } = await readTeamNotify(tenantId);
        const known = new Set(members.map((m) => m.userId));
        for (const id of [...lists.handoff, ...lists.hotLeads]) {
            if (!known.has(id)) {
                // The id is the caller's own, echoed back so the screen can say which row; it is not a secret.
                sendError(res, 400, 'ROUTING_INVALID', { userId: id.slice(0, 64) }, 'That person is not in this workspace.');
                return;
            }
        }
        await writeRouting(tenantId, lists, userOf(req));
        await writeAudit(await actorFromSession(req.session), {
            action: AUDIT_ACTIONS.notifyRoutingWrite, targetType: 'creator', targetId: tenantId,
            detail: { handoff_count: lists.handoff.length, hot_leads_count: lists.hotLeads.length },
        });
        res.json(await routingView(tenantId));
    } catch (err) {
        handle(res, 'notify.routing_write_failed', err);
    }
});
