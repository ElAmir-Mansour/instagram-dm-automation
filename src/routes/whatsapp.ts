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
 *   GET    /entry-links          any member   the number's QR codes and short links, read from Meta and joined with the owner's labels
 *   POST   /entry-links          owner        { label, prefill }: make one at Meta (the prefill gets a ` #ref` tracking code appended). 201
 *   DELETE /entry-links/:code    owner        delete it at Meta, drop its label. 204
 *   GET    /ice-breakers         any member   the ice breakers and commands set on the number, and Meta's limits
 *   PUT    /ice-breakers         owner        { prompts, commands? }: set them at Meta (≤ 4 × ≤ 80 characters, ≤ 30 commands, no emoji)
 *
 * **The token never leaves.** It is read once, in the body of `POST /connect`, validated, encrypted by `whatsappConnections.ts` and stored; no
 * answer, audit row or log line carries it, and every message built from a Meta error is scrubbed of it first. Reads are the same row without
 * the token columns.
 *
 * **Reads are open to any member and writes are the owner's**, as for TikTok and YouTube: a membership still means seeing the account, while
 * connecting a number, switching the agent on and agreeing to billable replies each change what real people receive or what it costs.
 *
 * Nothing here sends a WhatsApp message: no route calls `sendMessage`. The Meta writes are `POST /{waba_id}/subscribed_apps` on connect and
 * `DELETE` on disconnect, and, for the entry points, `message_qrdls` (create, delete) and `conversational_automation` on the number: each
 * behind a button, and none of them a message to a person.
 *
 * **Entry links and ice breakers live at Meta** (docs/specs/001-whatsapp-agent/research.md R13, `whatsappEntryLinks.ts`): the routes read them
 * from there on every call and write only a label per link into the connection's `settings`, so there is no migration and nothing to sync.
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
    COMMANDS_MAX, COMMAND_DESCRIPTION_MAX_CHARS, COMMAND_NAME_MAX_CHARS, createQrCode, deleteQrCode, getConversationalAutomation, getQrCode,
    ICE_BREAKER_MAX_CHARS, ICE_BREAKERS_MAX, isQrCodeId, listQrCodes, parseConversationalAutomation, setConversationalAutomation,
    type ConversationalAutomation,
} from '../services/whatsapp.js';
import {
    composePrefill, dropEntryLinkLabel, ENTRY_ERRORS, entryLinkView, getEntryLinkLabels, mergeEntryLinks, newUniqueRef, parseEntryLinkInput,
    putEntryLinkLabel, type EntryLinkLabel,
} from '../services/whatsappEntryLinks.js';
import { periodOf, periodUsage, projectMonthEnd } from '../services/channelUsage.js';
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

/** The meter before there is anything to read: no live connection, or a ledger that could not be read (`unavailable`). */
function emptyUsage(now: Date, unavailable = false) {
    return {
        period: periodOf(now),
        free_used: 0,
        free_limit: FREE_REPLIES_PER_MONTH,
        billable: 0,
        est_cost_usd: 0,
        projected_cost_usd: 0,
        ...(unavailable ? { unavailable: true } : {}),
    };
}

/**
 * The free-replies meter, from the `channel_usage` ledger for the current UTC month (channelUsage.ts; the period boundary is UTC until the account's
 * timezone is read, TODO(M12) there).
 *
 *   free_used           delivered service messages, capped at the 1,000 free ones: past that they are billable, and `billable` says how many
 *   billable            delivered messages Meta marked billable, any category
 *   est_cost_usd        what those cost so far at the rate table's rates (an estimate: Meta's invoice is the truth)
 *   projected_cost_usd  the month's estimate if the rest of it looks like the part that has passed
 *
 * A ledger that cannot be read does not fail the card (the connection and the agent are still true): it says `unavailable: true`, with zeros,
 * and the log says why. A tenant with no live connection has no number to count.
 */
async function usageOf(creatorId: string, connection: WhatsAppConnection | null, now: Date = new Date()) {
    if (!connection || connection.status === 'revoked') return emptyUsage(now);
    try {
        const used = await periodUsage(creatorId, connection.phoneNumberId, periodOf(now));
        return {
            period: used.period,
            free_used: Math.min(used.serviceDelivered, FREE_REPLIES_PER_MONTH),
            free_limit: FREE_REPLIES_PER_MONTH,
            billable: used.billable,
            est_cost_usd: used.estCostUsd,
            projected_cost_usd: projectMonthEnd(used.estCostUsd, now),
        };
    } catch (err) {
        log('warn', 'whatsapp.usage_unreadable', { creator_id: creatorId, ...describeError(err) });
        return emptyUsage(now, true);
    }
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
function view(connection: WhatsAppConnection | null, agent: WhatsAppAgentSettings, usage: Awaited<ReturnType<typeof usageOf>>) {
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
        usage,
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
    return view(conn, agent, await usageOf(creatorId, conn));
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

// ─── Entry points: links and QR codes, ice breakers ─────────────────────────────────────

/**
 * The tenant's live number and the token to ask Meta with, or null after answering 409. Everything below is an object of a CONNECTED number at
 * Meta, so there is nothing to read or write without one (and a connection Meta refused is not sent through: `getAccessToken` says so).
 */
async function numberOf(creatorId: string, res: Response): Promise<{ phoneNumberId: string; token: string } | null> {
    try {
        const { accessToken, connection } = await getAccessToken(creatorId);
        return { phoneNumberId: connection.phoneNumberId, token: accessToken };
    } catch (err) {
        if (err instanceof WhatsAppNotConnectedError) {
            res.status(409).json({ error: err.message, code: 'not_connected' });
            return null;
        }
        throw err;
    }
}

/**
 * A failed Meta call answered, when it is one (false otherwise, and the caller reports a server error). A refusal is the owner's to fix and
 * carries Meta's words; an unreachable Meta is 502 with the caller's own sentence, because "nothing was saved" is true of a read and a
 * delete and is NOT true of a create whose answer never came.
 */
function answerMetaFailure(res: Response, event: string, err: unknown, token: string, code: string, unreachable: string): boolean {
    if (!isMetaFailure(err)) return false;
    log('warn', event, describeScrubbed(err, token));
    const answer = metaFailureAnswer(err, token, code);
    res.status(answer.status).json(answer.status === 502 ? { ...answer.body, error: unreachable } : answer.body);
    return true;
}

// ── Entry links ──

whatsappRouter.get('/entry-links', async (req, res) => {
    const creatorId = getTenantId(req);
    let token = '';
    try {
        const number = await numberOf(creatorId, res);
        if (!number) return;
        token = number.token;
        const [codes, labels] = await Promise.all([listQrCodes(number.phoneNumberId, token), getEntryLinkLabels(creatorId)]);
        res.json(mergeEntryLinks(codes, labels));
    } catch (err) {
        if (answerMetaFailure(res, 'whatsapp.entry_links_read_refused', err, token, ENTRY_ERRORS.linksUnreadable, 'Meta could not be reached. Try again in a moment.')) return;
        fail(res, 'api.whatsapp_entry_links_read_failed', 'Failed to read the WhatsApp entry links.', err);
    }
});

whatsappRouter.post('/entry-links', canAdminister, async (req, res) => {
    const parsed = parseEntryLinkInput(req.body);
    if ('error' in parsed) {
        res.status(400).json(parsed);
        return;
    }
    const creatorId = getTenantId(req);
    let token = '';
    try {
        const number = await numberOf(creatorId, res);
        if (!number) return;
        token = number.token;

        // The ref is made here, not by Meta, and is unique among this tenant's labels. It goes INTO the message, which is why Meta's
        // 140 characters are checked on the sum and never cut: a cut would take the ref off the end.
        const labels = await getEntryLinkLabels(creatorId);
        const ref = newUniqueRef(new Set(Object.values(labels).map((l) => l.ref)));
        const message = composePrefill(parsed.value.prefill, ref);
        if ('error' in message) {
            res.status(400).json(message);
            return;
        }

        // The one Meta write that creates something. Never retried once it may have landed (createQrCode), so an answer that never came
        // is reported as "may or may not exist": the list is the truth, and a code made twice is a harmless extra, not a silent loss.
        let qr;
        try {
            qr = await createQrCode(number.phoneNumberId, token, message.text);
        } catch (err) {
            if (answerMetaFailure(res, 'whatsapp.entry_link_create_refused', err, token, ENTRY_ERRORS.qrRefused,
                'Meta did not answer, so the link may or may not have been created. Check the list before trying again.')) return;
            throw err;
        }

        // From here the link EXISTS at Meta. Saving its label is best effort: if it fails the link is still real and still listed (its
        // ref is read back from the message), so the answer is the link plus `label_saved: false`, never an error that invites a second one.
        const entry: EntryLinkLabel = { label: parsed.value.label, ref, created_at: new Date().toISOString() };
        let labelSaved = false;
        try {
            labelSaved = await putEntryLinkLabel(creatorId, qr.code, entry);
        } catch (err) {
            log('error', 'whatsapp.entry_link_label_failed', { creator_id: creatorId, code: qr.code, ...describeError(err) });
        }

        await writeAudit(await actorFromSession(req.session), {
            action: AUDIT_ACTIONS.whatsappEntryLinkCreate,
            targetType: 'creator',
            targetId: creatorId,
            detail: { code: qr.code, ref, label_saved: labelSaved },
        });
        log('info', 'whatsapp.entry_link_created', { creator_id: creatorId, code: qr.code, label_saved: labelSaved });
        res.status(201).json({ ...entryLinkView(qr, entry), label_saved: labelSaved });
    } catch (err) {
        fail(res, 'api.whatsapp_entry_link_create_failed', 'Failed to create the WhatsApp entry link.', err);
    }
});

whatsappRouter.delete('/entry-links/:code', canAdminister, async (req, res) => {
    const code = req.params.code;
    if (!isQrCodeId(code)) {
        res.status(400).json({ error: 'code is not a QR code id.', code: ENTRY_ERRORS.invalidCode });
        return;
    }
    const creatorId = getTenantId(req);
    let token = '';
    try {
        const number = await numberOf(creatorId, res);
        if (!number) return;
        token = number.token;

        // The code must be one of THIS number's: Meta is asked for it through the number first, so a code of another business is a 404
        // here whatever Meta would have done with the delete.
        if (!(await getQrCode(number.phoneNumberId, token, code))) {
            res.status(404).json({ error: 'That entry link does not exist on this number.', code: ENTRY_ERRORS.notFound });
            return;
        }
        if (!(await deleteQrCode(number.phoneNumberId, token, code))) {
            res.status(502).json({ error: 'Meta did not confirm the deletion. Check the list before trying again.', code: ENTRY_ERRORS.notConfirmed });
            return;
        }

        // Deleted at Meta: the label is housekeeping now. A failure leaves an orphan the list never shows (it joins from Meta's side).
        try {
            await dropEntryLinkLabel(creatorId, code);
        } catch (err) {
            log('warn', 'whatsapp.entry_link_label_drop_failed', { creator_id: creatorId, code, ...describeError(err) });
        }
        await writeAudit(await actorFromSession(req.session), {
            action: AUDIT_ACTIONS.whatsappEntryLinkDelete,
            targetType: 'creator',
            targetId: creatorId,
            detail: { code },
        });
        log('info', 'whatsapp.entry_link_deleted', { creator_id: creatorId, code });
        res.status(204).end();
    } catch (err) {
        if (answerMetaFailure(res, 'whatsapp.entry_link_delete_refused', err, token, ENTRY_ERRORS.qrRefused, 'Meta could not be reached — nothing was deleted. Try again in a moment.')) return;
        fail(res, 'api.whatsapp_entry_link_delete_failed', 'Failed to delete the WhatsApp entry link.', err);
    }
});

// ── Ice breakers and commands ──

/** Meta's limits, sent with every read so the card can count against them instead of hardcoding a copy. */
const ICE_BREAKER_LIMITS = {
    prompts: ICE_BREAKERS_MAX,
    prompt_chars: ICE_BREAKER_MAX_CHARS,
    commands: COMMANDS_MAX,
    command_name_chars: COMMAND_NAME_MAX_CHARS,
    command_description_chars: COMMAND_DESCRIPTION_MAX_CHARS,
} as const;

const iceBreakersView = (state: ConversationalAutomation) => ({ prompts: state.prompts, commands: state.commands, limits: ICE_BREAKER_LIMITS });

whatsappRouter.get('/ice-breakers', async (req, res) => {
    let token = '';
    try {
        const number = await numberOf(getTenantId(req), res);
        if (!number) return;
        token = number.token;
        res.json({ ...iceBreakersView(await getConversationalAutomation(number.phoneNumberId, token)), verified: true });
    } catch (err) {
        if (answerMetaFailure(res, 'whatsapp.ice_breakers_read_refused', err, token, ENTRY_ERRORS.iceBreakersUnreadable, 'Meta could not be reached. Try again in a moment.')) return;
        fail(res, 'api.whatsapp_ice_breakers_read_failed', 'Failed to read the WhatsApp ice breakers.', err);
    }
});

whatsappRouter.put('/ice-breakers', canAdminister, async (req, res) => {
    const parsed = parseConversationalAutomation(req.body);
    if ('error' in parsed) {
        res.status(400).json(parsed);
        return;
    }
    const creatorId = getTenantId(req);
    let token = '';
    try {
        const number = await numberOf(creatorId, res);
        if (!number) return;
        token = number.token;

        if (!(await setConversationalAutomation(number.phoneNumberId, token, parsed.value))) {
            res.status(502).json({ error: 'Meta did not confirm the change. Read the ice breakers again to see what is set.', code: ENTRY_ERRORS.notConfirmed });
            return;
        }
        await writeAudit(await actorFromSession(req.session), {
            action: AUDIT_ACTIONS.whatsappIceBreakersWrite,
            targetType: 'creator',
            targetId: creatorId,
            detail: { prompt_count: parsed.value.prompts.length, command_count: parsed.value.commands ? parsed.value.commands.length : null },
        });
        log('info', 'whatsapp.ice_breakers_set', { creator_id: creatorId, prompts: parsed.value.prompts.length });

        // Meta does not say whether a POST replaces or adds to what is set, so the answer is what Meta holds NOW. If that read fails the
        // write still stands: say so (`verified: false`), with what was sent and `commands: null` when none were.
        try {
            res.json({ ...iceBreakersView(await getConversationalAutomation(number.phoneNumberId, token)), verified: true });
        } catch (readErr) {
            log('warn', 'whatsapp.ice_breakers_reread_failed', { creator_id: creatorId, ...describeScrubbed(readErr, token) });
            res.json({ prompts: parsed.value.prompts, commands: parsed.value.commands ?? null, limits: ICE_BREAKER_LIMITS, verified: false });
        }
    } catch (err) {
        if (answerMetaFailure(res, 'whatsapp.ice_breakers_write_refused', err, token, ENTRY_ERRORS.iceBreakersRefused, 'Meta could not be reached — nothing was changed. Try again in a moment.')) return;
        fail(res, 'api.whatsapp_ice_breakers_save_failed', 'Failed to save the WhatsApp ice breakers.', err);
    }
});
