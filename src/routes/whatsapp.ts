/**
 * WhatsApp routes, under `/api/whatsapp` (docs/specs/001-whatsapp-agent/contracts/dashboard-api.md). Mounted BELOW `resolveTenant` in api.ts,
 * so every route acts as the session's tenant and touches that tenant's connection and agent only.
 *
 *   GET    /connection   any member   the Settings card: the connection, the agent mode, the free-replies meter, the go-live gate
 *   POST   /connect      owner        { waba_id, phone_number_id, access_token }: validate with Meta, subscribe the app, store the token encrypted
 *   POST   /refresh      owner        re-read the number's health from Meta
 *   DELETE /connection   owner        unsubscribe the app, wipe the token, agent mode off. 204
 *   PUT    /agent        owner        { mode, test_senders? }: who the agent answers. `everyone` is refused (409) until the go-live gate exists
 *   PUT    /billing      owner        { allow_billable, free_tier_alert_at? }: the owner's choices about replies Meta would charge for
 *
 * **The token never leaves.** It is read once, in the body of `POST /connect`, validated, encrypted by `whatsappConnections.ts` and stored; no
 * answer, audit row or log line carries it, and every message built from a Meta error is scrubbed of it first. Reads are the same row without
 * the token columns.
 *
 * **Reads are open to any member and writes are the owner's**, as for TikTok and YouTube: a membership still means seeing the account, while
 * connecting a number, switching the agent on and agreeing to billable replies each change what real people receive or what it costs.
 *
 * Nothing here sends a WhatsApp message: no route calls `sendMessage`. The only Meta writes are `POST /{waba_id}/subscribed_apps` on connect
 * and `DELETE` on disconnect, each behind a button.
 */
import axios from 'axios';
import { Router } from 'express';
import type { Response } from 'express';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from '../services/audit.js';
import { isMissingSchema } from '../services/health.js';
import { MetaApiError } from '../services/instagram.js';
import { fetchDebugToken } from '../services/tokenHealth.js';
import { getPhoneNumberHealth, inspectWhatsAppToken, scrubToken, subscribeApp, unsubscribeApp } from '../services/whatsapp.js';
import {
    DEFAULT_WHATSAPP_SETTINGS, FREE_REPLIES_PER_MONTH, getAccessToken, getConnection, getConnectionByPhoneNumberId, isAlertThreshold, isAuthRefusal,
    refreshHealth, revokeConnection, saveConnection, updateSettings, WhatsAppNotConnectedError, WhatsAppNumberInUseError,
    type WhatsAppConnection, type WhatsAppSettings,
} from '../services/whatsappConnections.js';
import {
    isWhatsAppMode, parseWhatsAppTestSenders, readWhatsAppSettings, writeWhatsAppSettings, type WhatsAppAgentSettings,
} from '../services/whatsappAgent.js';
import { describeError, log } from '../utils/log.js';

export const whatsappRouter = Router();

/** Connecting, disconnecting, the agent and the billing choice are the owner's: see the top of the file. */
const canAdminister = requireTenantRole('owner');

const MIGRATION_HINT = 'The database is missing migration v50 (src/config/migration_v50_whatsapp.sql), which adds the WhatsApp columns. Apply it with `npm run migrate`, then try again.';

// ─── The answer ─────────────────────────────────────────────────────────────────────────

/** The free-replies meter. TODO(W3 channelUsage): `free_used`, `billable` and the two costs come from the `channel_usage` ledger; until that exists they are zero. */
function usagePlaceholder(now: Date = new Date()) {
    return {
        period: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
        free_used: 0,
        free_limit: FREE_REPLIES_PER_MONTH,
        billable: 0,
        est_cost_usd: 0,
        projected_cost_usd: 0,
    };
}

/**
 * What stands between the owner and mode `everyone`. TODO(T061): the real gate (connection active and not a test number, public pages naming
 * WhatsApp, provider allow-list satisfied) arrives with the go-live phase; until then `ready` is false whatever the connection says, and the two
 * items that gate will check are always listed.
 */
export function goLiveStatus(connection: WhatsAppConnection | null): { ready: boolean; missing: string[] } {
    const missing: string[] = [];
    if (!connection || connection.status !== 'active') missing.push('active_connection');
    if (connection?.profile.is_test_number) missing.push('not_test_number');
    missing.push('public_pages', 'provider_allow_list');
    return { ready: false, missing };
}

/** The Settings card's state (the contract's `GET /api/whatsapp/connection`). Never a token: the connection type has no such field. */
function view(connection: WhatsAppConnection | null, agent: WhatsAppAgentSettings) {
    const live = connection && connection.status !== 'revoked' ? connection : null;
    const profile = live?.profile;
    return {
        connected: live?.status === 'active',
        status: connection?.status ?? null,
        phone_number_id: live?.phoneNumberId ?? null,
        display_phone_number: profile?.display_phone_number ?? null,
        verified_name: live?.displayName ?? null,
        quality_rating: profile?.quality_rating ?? null,
        messaging_limit: profile?.messaging_limit ?? null,
        name_status: profile?.name_status ?? null,
        number_status: profile?.number_status ?? null,
        is_test_number: profile?.is_test_number ?? false,
        last_error: live?.lastError ?? null,
        last_refreshed_at: live?.lastRefreshedAt ?? null,
        token_expires_at: live?.accessExpiresAt ?? null,
        mode: agent.mode,
        test_senders: agent.testSenders,
        usage: usagePlaceholder(),
        allow_billable: live?.settings.allow_billable ?? false,
        free_tier_alert_at: live?.settings.free_tier_alert_at ?? DEFAULT_WHATSAPP_SETTINGS.free_tier_alert_at,
        go_live: goLiveStatus(live),
    };
}

async function currentView(creatorId: string, connection?: WhatsAppConnection | null) {
    const [conn, agent] = await Promise.all([
        connection === undefined ? getConnection(creatorId) : Promise.resolve(connection),
        readWhatsAppSettings(creatorId),
    ]);
    return view(conn, agent);
}

// ─── Errors ─────────────────────────────────────────────────────────────────────────────

/** Meta's own words for a failure, whichever shape the error came in (a rewrapped `MetaApiError`, or axios's own). */
function metaMessage(err: unknown): string {
    const e = err as { message?: unknown; response?: { data?: { error?: { message?: unknown } } } } | null;
    const fromMeta = e?.response?.data?.error?.message;
    if (typeof fromMeta === 'string' && fromMeta) return fromMeta;
    return typeof e?.message === 'string' && e.message ? e.message : 'Meta refused the request.';
}

/** The HTTP status Meta answered with, or undefined when nothing answered (a timeout, a reset, DNS). */
function httpStatusOf(err: unknown): number | undefined {
    const e = err as { response?: { status?: unknown }; cause?: { response?: { status?: unknown } } } | null;
    const status = e?.cause?.response?.status ?? e?.response?.status;
    return typeof status === 'number' ? status : undefined;
}

/** A failure that came from Meta (a Graph call rewrapped by `metaFailure`, or `debug_token`'s own axios error), as opposed to a bug or the database. */
function isMetaFailure(err: unknown): boolean {
    return err instanceof MetaApiError || axios.isAxiosError(err);
}

/** `describeError` for a log line in a handler that holds the pasted token: Meta's words are scrubbed of it, whatever they say. */
function describeScrubbed(err: unknown, token: string): Record<string, unknown> {
    return Object.fromEntries(Object.entries(describeError(err)).map(([k, v]) => [k, typeof v === 'string' ? scrubToken(v, token) : v]));
}

/**
 * What a failed Meta call answers: a refusal (4xx) is the owner's to fix, in Meta's words; an unreachable or failing Meta (nothing answered,
 * a 5xx, a 429) is 502, and says nothing was saved.
 */
function metaFailureAnswer(err: unknown, token: string, code: string): { status: number; body: { error: string; code: string } } {
    const http = httpStatusOf(err);
    if (http === undefined || http >= 500 || http === 429) {
        return { status: 502, body: { error: 'Meta could not be reached — nothing was saved. Try again in a moment.', code: 'meta_unreachable' } };
    }
    return { status: 400, body: { error: scrubToken(metaMessage(err), token), code } };
}

function fail(res: Response, event: string, fallback: string, err: unknown): void {
    if (isMissingSchema(err)) {
        log('error', event, describeError(err));
        res.status(503).json({ error: MIGRATION_HINT, migrationPending: true });
        return;
    }
    log('error', event, describeError(err));
    res.status(500).json({ error: fallback });
}

// ─── Reading ────────────────────────────────────────────────────────────────────────────

whatsappRouter.get('/connection', async (req, res) => {
    try {
        res.json(await currentView(getTenantId(req)));
    } catch (err) {
        fail(res, 'api.whatsapp_connection_read_failed', 'Failed to read the WhatsApp connection.', err);
    }
});

// ─── Connecting ─────────────────────────────────────────────────────────────────────────

const META_ID = /^\d{5,32}$/;
/** Printable ASCII, no spaces. Meta's tokens are alphanumeric; the bound only stops a pasted paragraph. */
const TOKEN_SHAPE = /^[\x21-\x7E]{20,2000}$/;

whatsappRouter.post('/connect', canAdminister, async (req, res) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const wabaId = typeof body.waba_id === 'string' ? body.waba_id.trim() : '';
    const phoneNumberId = typeof body.phone_number_id === 'string' ? body.phone_number_id.trim() : '';
    const token = typeof body.access_token === 'string' ? body.access_token.trim() : '';

    if (!META_ID.test(wabaId)) {
        res.status(400).json({ error: 'waba_id must be the WhatsApp Business Account id: a number, 5 to 32 digits.', code: 'invalid_waba_id' });
        return;
    }
    if (!META_ID.test(phoneNumberId)) {
        res.status(400).json({ error: 'phone_number_id must be the phone number id from API Setup: a number, 5 to 32 digits.', code: 'invalid_phone_number_id' });
        return;
    }
    if (!TOKEN_SHAPE.test(token)) {
        res.status(400).json({ error: 'access_token does not look like a Meta access token.', code: 'invalid_access_token' });
        return;
    }

    try {
        const creatorId = getTenantId(req);

        // A number another workspace holds is refused before anything is asked of Meta, let alone written to it.
        const holder = await getConnectionByPhoneNumberId(phoneNumberId);
        if (holder && holder.creatorId !== creatorId) {
            res.status(409).json({ error: new WhatsAppNumberInUseError().message, code: 'number_in_use' });
            return;
        }

        // 1. The token: valid, issued to THIS app, and carrying both scopes.
        let inspection;
        try {
            inspection = inspectWhatsAppToken(await fetchDebugToken(token), process.env.META_APP_ID?.trim() || null);
        } catch (err) {
            log('warn', 'whatsapp.connect_debug_token_failed', describeScrubbed(err, token));
            const answer = metaFailureAnswer(err, token, 'token_refused');
            res.status(answer.status).json(answer.body);
            return;
        }
        if (inspection.error) {
            res.status(400).json({ error: scrubToken(inspection.error, token), code: inspection.isValid && inspection.missingScopes.length ? 'missing_scopes' : 'token_refused' });
            return;
        }

        // 2. The number: readable with this token. Also what the card shows.
        let health;
        try {
            health = await getPhoneNumberHealth(phoneNumberId, token);
        } catch (err) {
            log('warn', 'whatsapp.connect_health_failed', describeScrubbed(err, token));
            const answer = metaFailureAnswer(err, token, 'number_unreadable');
            res.status(answer.status).json(answer.body);
            return;
        }

        // 3. The webhook: the app starts receiving this account's events. The one Meta write, and idempotent.
        try {
            if (!(await subscribeApp(wabaId, token))) {
                res.status(400).json({ error: 'Meta did not confirm the webhook subscription for that WhatsApp Business Account.', code: 'subscribe_failed' });
                return;
            }
        } catch (err) {
            log('warn', 'whatsapp.connect_subscribe_failed', describeScrubbed(err, token));
            const answer = metaFailureAnswer(err, token, 'subscribe_failed');
            res.status(answer.status).json(answer.body);
            return;
        }

        // 4. Stored, encrypted. From here on nothing in this handler touches the token.
        const connection = await saveConnection({
            creatorId, userId: req.session?.userId ?? null, phoneNumberId, wabaId, accessToken: token,
            health, scopes: inspection.scopes, accessExpiresAt: inspection.expiresAt,
        });

        await writeAudit(await actorFromSession(req.session), {
            action: AUDIT_ACTIONS.whatsappConnect,
            targetType: 'creator',
            targetId: creatorId,
            detail: {
                phone_number_id: phoneNumberId,
                waba_id: wabaId,
                display_phone_number: health.displayPhoneNumber,
                is_test_number: health.isTestNumber,
                scopes: inspection.scopes,
                expires: inspection.expiresAt ? inspection.expiresAt.toISOString() : null,
            },
        });
        log('info', 'whatsapp.connected', { creator_id: creatorId, phone_number_id: phoneNumberId, is_test_number: health.isTestNumber });
        res.json(await currentView(creatorId, connection));
    } catch (err) {
        if (err instanceof WhatsAppNumberInUseError) {
            res.status(409).json({ error: err.message, code: 'number_in_use' });
            return;
        }
        fail(res, 'api.whatsapp_connect_failed', 'Failed to connect WhatsApp.', err);
    }
});

// ─── Refreshing ─────────────────────────────────────────────────────────────────────────

whatsappRouter.post('/refresh', canAdminister, async (req, res) => {
    const creatorId = getTenantId(req);
    try {
        res.json(await currentView(creatorId, await refreshHealth(creatorId)));
    } catch (err) {
        if (err instanceof WhatsAppNotConnectedError) {
            res.status(409).json({ error: err.message, code: 'not_connected' });
            return;
        }
        // Meta refused the token or a permission: `refreshHealth` has already marked the connection invalid. That is what the refresh found, so
        // the card gets the state it now has, not an error.
        if (isAuthRefusal(err)) {
            try {
                res.json(await currentView(creatorId));
                return;
            } catch (readErr) {
                fail(res, 'api.whatsapp_refresh_failed', 'Failed to refresh WhatsApp.', readErr);
                return;
            }
        }
        // Meta answered with something other than a token refusal, or did not answer: the stored state is untouched.
        if (isMetaFailure(err)) {
            log('warn', 'api.whatsapp_refresh_refused', describeError(err));
            const reachable = httpStatusOf(err) !== undefined && !(httpStatusOf(err)! >= 500);
            res.status(502).json(reachable
                ? { error: metaMessage(err), code: 'meta_refused' }
                : { error: 'Meta could not be reached. Try again in a moment.', code: 'meta_unreachable' });
            return;
        }
        fail(res, 'api.whatsapp_refresh_failed', 'Failed to refresh WhatsApp.', err);
    }
});

// ─── Disconnecting ──────────────────────────────────────────────────────────────────────

whatsappRouter.delete('/connection', canAdminister, async (req, res) => {
    try {
        const creatorId = getTenantId(req);

        // Unsubscribe first, with the token we are about to wipe. Best effort, as TikTok's revoke is: an account Meta already considers dead
        // cannot be unsubscribed, and that must not trap the owner with a connection they cannot remove.
        let unsubscribed = false;
        try {
            const { accessToken, connection } = await getAccessToken(creatorId, { allowInvalid: true });
            if (connection.profile.waba_id) {
                try {
                    unsubscribed = await unsubscribeApp(connection.profile.waba_id, accessToken);
                } catch (err) {
                    log('warn', 'whatsapp.unsubscribe_failed', { creator_id: creatorId, ...describeError(err) });
                }
            }
        } catch (err) {
            if (!(err instanceof WhatsAppNotConnectedError)) throw err;
        }

        if (!(await revokeConnection(creatorId))) {
            res.status(404).json({ error: 'WhatsApp is not connected.', code: 'not_connected' });
            return;
        }

        // Reconnecting must not silently resume answering the public: the agent goes back to off. A tenant with no agent row has nothing to turn off.
        try {
            await writeWhatsAppSettings(creatorId, { mode: 'off' });
        } catch (err) {
            log('warn', 'whatsapp.agent_off_failed', { creator_id: creatorId, ...describeError(err) });
        }

        await writeAudit(await actorFromSession(req.session), {
            action: AUDIT_ACTIONS.whatsappDisconnect,
            targetType: 'creator',
            targetId: creatorId,
            detail: { unsubscribed_from_meta: unsubscribed },
        });
        log('info', 'whatsapp.disconnected', { creator_id: creatorId, unsubscribed });
        res.status(204).end();
    } catch (err) {
        fail(res, 'api.whatsapp_disconnect_failed', 'Failed to disconnect WhatsApp.', err);
    }
});

// ─── The agent ──────────────────────────────────────────────────────────────────────────

whatsappRouter.put('/agent', canAdminister, async (req, res) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    if (!isWhatsAppMode(body.mode)) {
        res.status(400).json({ error: 'mode must be "off", "test" or "everyone".', code: 'invalid_mode' });
        return;
    }
    let testSenders: string[] | undefined;
    if (body.test_senders !== undefined && body.test_senders !== null) {
        const parsed = parseWhatsAppTestSenders(body.test_senders);
        if ('error' in parsed) {
            res.status(400).json({ error: parsed.error, code: 'invalid_test_senders' });
            return;
        }
        testSenders = parsed.senders;
    }

    try {
        const creatorId = getTenantId(req);

        // `everyone` is ALWAYS refused in this phase, whatever the connection looks like: it puts the agent in front of the public, and the pages
        // that name WhatsApp as a processor do not exist yet. TODO(T061): the go-live gate decides; until then this does not consult `ready`.
        if (body.mode === 'everyone') {
            const gate = goLiveStatus(await getConnection(creatorId));
            res.status(409).json({ error: 'go_live_not_ready', missing: gate.missing });
            return;
        }

        const saved = await writeWhatsAppSettings(creatorId, { mode: body.mode, ...(testSenders ? { testSenders } : {}) });
        if (!saved) {
            res.status(409).json({
                error: 'agent_not_configured',
                message: 'This account has no AI agent yet — save the AI agent settings first, then choose how it answers on WhatsApp.',
            });
            return;
        }
        await writeAudit(await actorFromSession(req.session), {
            action: AUDIT_ACTIONS.whatsappAgentWrite,
            targetType: 'creator',
            targetId: creatorId,
            detail: { mode: saved.mode, test_sender_count: saved.testSenders.length, senders_changed: testSenders !== undefined },
        });
        log('info', 'whatsapp.agent_mode_set', { creator_id: creatorId, mode: saved.mode, test_senders: saved.testSenders.length });
        res.json(await currentView(creatorId));
    } catch (err) {
        fail(res, 'api.whatsapp_agent_save_failed', 'Failed to save the WhatsApp agent settings.', err);
    }
});

// ─── Billing ────────────────────────────────────────────────────────────────────────────

whatsappRouter.put('/billing', canAdminister, async (req, res) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    if (typeof body.allow_billable !== 'boolean') {
        res.status(400).json({ error: 'allow_billable must be true or false.', code: 'invalid_allow_billable' });
        return;
    }
    const patch: Partial<WhatsAppSettings> = { allow_billable: body.allow_billable };
    if (body.free_tier_alert_at !== undefined && body.free_tier_alert_at !== null) {
        if (!isAlertThreshold(body.free_tier_alert_at)) {
            res.status(400).json({ error: `free_tier_alert_at must be a whole number from 0 to ${FREE_REPLIES_PER_MONTH}.`, code: 'invalid_free_tier_alert_at' });
            return;
        }
        patch.free_tier_alert_at = body.free_tier_alert_at;
    }

    try {
        const creatorId = getTenantId(req);
        const connection = await updateSettings(creatorId, patch);
        if (!connection) {
            res.status(409).json({ error: 'not_connected', message: 'WhatsApp is not connected — connect a number first.' });
            return;
        }
        await writeAudit(await actorFromSession(req.session), {
            action: AUDIT_ACTIONS.whatsappBillingWrite,
            targetType: 'creator',
            targetId: creatorId,
            detail: { allow_billable: connection.settings.allow_billable, free_tier_alert_at: connection.settings.free_tier_alert_at },
        });
        log('info', 'whatsapp.billing_set', { creator_id: creatorId, allow_billable: connection.settings.allow_billable });
        res.json(await currentView(creatorId, connection));
    } catch (err) {
        fail(res, 'api.whatsapp_billing_save_failed', 'Failed to save the WhatsApp billing settings.', err);
    }
});
