/**
 * TikTok routes, under `/api/tiktok`.
 *
 * Two routers, because two of these endpoints are reached by TikTok rather than by the
 * dashboard and so can carry no session:
 *
 *   tiktokPublicRouter — mounted ABOVE `requireAuth` in api.ts
 *     GET  /callback   the OAuth redirect target; trusts only the single-use `state`
 *     POST /webhook    TikTok's event delivery; trusts only the `Tiktok-Signature` HMAC
 *
 *   tiktokRouter — mounted BELOW `resolveTenant`, so every route acts as the session's tenant
 *     GET  /connection     the Settings card: connected account, app readiness, inbox usage
 *     GET  /creator-info   the composer's Direct Post panel: TikTok's live creator_info
 *     POST /connect        owner: mint a state, return TikTok's authorise URL
 *     POST /disconnect     owner: revoke and delete
 *     GET  /app-settings   platform admin: client key/secret status, URLs to register
 *     POST /app-settings   platform admin: save them
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from '../services/audit.js';
import {
    APP_SETTING_KEYS, getPublicBaseUrl, getSetting, getTikTokAppConfig, getTikTokPostingFlags, maskValue,
    normaliseOrigin, saveVerificationFile, setSetting,
} from '../services/appSettings.js';
import {
    buildAuthorizeUrl, parseWebhookEvent, queryCreatorInfo, tiktokScopes, verifyTikTokSignature,
} from '../services/tiktok.js';
import {
    completeConnection, consumeOAuthState, createOAuthState, disconnect, getAccessToken, getConnection,
    OAUTH_STATE_TTL_MS, summariseConnection, TikTokAccountInUseError, TikTokNotConnectedError,
} from '../services/tiktokConnections.js';
import { applyWebhookEvent, MAX_PENDING_INBOX_SHARES, pendingInboxShares } from '../services/tiktokPublish.js';
import { describeError, log } from '../utils/log.js';

/** Carries the state through TikTok's round trip so it can only complete in the browser that began it. */
export const STATE_COOKIE = 'tiktok_oauth_state';
export const CALLBACK_PATH = '/api/tiktok/callback';
export const WEBHOOK_PATH = '/api/tiktok/webhook';

function requestOrigin(req: Request): string | null {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0]!.trim();
    const host = req.get('host');
    return host ? `${proto}://${host}` : null;
}

export async function redirectUriFor(req: Request): Promise<string | null> {
    const base = await getPublicBaseUrl(requestOrigin(req));
    return base ? `${base}${CALLBACK_PATH}` : null;
}

/** A single cookie from the header, without pulling in cookie-parser for one value. */
export function readCookie(header: string | undefined, name: string): string | null {
    if (!header) return null;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i === -1) continue;
        if (part.slice(0, i).trim() === name) {
            try {
                return decodeURIComponent(part.slice(i + 1).trim());
            } catch {
                return null;
            }
        }
    }
    return null;
}

function stateCookie(value: string, maxAgeSeconds: number): string {
    // Path-scoped to the callback: no other route ever sees it. Lax, because the callback is a
    // top-level navigation from tiktok.com — Strict would drop it on exactly that request.
    return `${STATE_COOKIE}=${encodeURIComponent(value)}; Path=${CALLBACK_PATH}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Back to Settings with an outcome the page turns into a toast. The parameters go in the HASH
 * query (`#/settings?tiktok=…`), because that is where the dashboard's router reads them
 * (`App.hashParam`) — a `?tiktok=` before the `#` is invisible to it, and the toast never showed.
 */
function backToSettings(res: Response, outcome: 'connected' | 'error', reason?: string): void {
    const params = new URLSearchParams({ tiktok: outcome });
    if (reason) params.set('reason', reason);
    res.setHeader('Set-Cookie', stateCookie('', 0));
    res.redirect(302, `/dashboard#/settings?${params.toString()}`);
}

// ─── Public ─────────────────────────────────────────────────────────────────────────────

export const tiktokPublicRouter = Router();

tiktokPublicRouter.get('/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const denied = typeof req.query.error === 'string' ? req.query.error : '';

    try {
        // The user pressed "Cancel" on TikTok's consent screen, or TikTok refused the request
        // (e.g. a scope the app is not approved for).
        if (denied) {
            log('warn', 'tiktok.oauth_denied', { error: denied });
            backToSettings(res, 'error', denied === 'access_denied' ? 'denied' : 'tiktok_error');
            return;
        }
        if (!state || !code) {
            backToSettings(res, 'error', 'missing_code');
            return;
        }

        // The browser that started the flow holds the same value. A state lifted from a log or a
        // referrer and completed elsewhere fails here, before it is spent.
        const cookie = readCookie(req.headers.cookie, STATE_COOKIE);
        if (!cookie || cookie !== state) {
            log('warn', 'tiktok.oauth_state_mismatch', { has_cookie: Boolean(cookie) });
            backToSettings(res, 'error', 'state_mismatch');
            return;
        }

        const claim = await consumeOAuthState(state);
        if (!claim) {
            backToSettings(res, 'error', 'state_expired');
            return;
        }

        const redirectUri = await redirectUriFor(req);
        if (!redirectUri) {
            backToSettings(res, 'error', 'no_base_url');
            return;
        }

        const connection = await completeConnection({
            creatorId: claim.creatorId, userId: claim.userId, code, redirectUri,
        });

        await writeAudit(await actorFromSession({ userId: claim.userId }), {
            action: AUDIT_ACTIONS.tiktokConnect,
            targetType: 'creator',
            targetId: claim.creatorId,
            detail: {
                account_name: connection.display_name,
                scopes: connection.scopes,
                upload_granted: connection.scopes.includes('video.upload'),
            },
        });
        log('info', 'tiktok.connected', { creator_id: claim.creatorId, scopes: connection.scopes });
        backToSettings(res, 'connected');
    } catch (err) {
        log('error', 'tiktok.oauth_callback_failed', describeError(err));
        backToSettings(res, 'error', err instanceof TikTokAccountInUseError ? 'account_in_use' : 'exchange_failed');
    }
});

tiktokPublicRouter.post('/webhook', async (req, res) => {
    try {
        const app = await getTikTokAppConfig();
        const header = req.get('tiktok-signature');
        if (!app || !verifyTikTokSignature(header, req.rawBody, app.clientSecret)) {
            // Same stance as the Meta webhook: a rejection is logged, because otherwise it is
            // indistinguishable from TikTok never calling.
            log('warn', 'tiktok.webhook_signature_rejected', {
                has_header: Boolean(header), app_configured: Boolean(app),
            });
            res.status(401).json({ error: 'Invalid signature.' });
            return;
        }

        const event = parseWebhookEvent(req.body);
        if (!event) {
            res.status(200).json({ received: true });
            return;
        }
        const outcome = await applyWebhookEvent(event);
        log('info', 'tiktok.webhook_applied', { event: event.event, outcome });
        res.status(200).json({ received: true });
    } catch (err) {
        // A 5xx makes TikTok retry, which is what we want when our side failed.
        log('error', 'tiktok.webhook_failed', describeError(err));
        res.status(500).json({ error: 'Webhook processing failed.' });
    }
});

// ─── Authenticated ──────────────────────────────────────────────────────────────────────

export const tiktokRouter = Router();

const canAdminister = requireTenantRole('owner');

function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): void {
    if (req.session?.role !== 'platform_admin') {
        res.status(404).json({ error: 'Not found.' });
        return;
    }
    next();
}

tiktokRouter.get('/connection', async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const [row, app, redirectUri, pending, flags] = await Promise.all([
            getConnection(creatorId),
            getTikTokAppConfig(),
            redirectUriFor(req),
            pendingInboxShares(creatorId),
            getTikTokPostingFlags(),
        ]);
        const connection = summariseConnection(row);
        res.json({
            appConfigured: Boolean(app),
            redirectUri,
            connection: {
                ...connection,
                directPostEnabled: flags.directPostEnabled,
                audited: flags.audited,
                postMode: postModeFor(connection.canDirectPost, flags.directPostEnabled),
            },
            inbox: { pending, limit: MAX_PENDING_INBOX_SHARES },
        });
    } catch (err) {
        log('error', 'api.tiktok_connection_read_failed', describeError(err));
        res.status(500).json({ error: 'Failed to read the TikTok connection.' });
    }
});

/** Direct only when the connection holds `video.publish` AND the operator has switched it on. */
export function postModeFor(canDirectPost: boolean, directPostEnabled: boolean): 'direct' | 'inbox' {
    return canDirectPost && directPostEnabled ? 'direct' : 'inbox';
}

/**
 * The composer's Direct Post panel is built from this, live, as TikTok's guidelines require:
 * the nickname shown, only the privacy levels this creator may use, interaction toggles greyed
 * where the creator has disabled them, and their maximum video length.
 */
tiktokRouter.get('/creator-info', async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const [row, flags] = await Promise.all([getConnection(creatorId), getTikTokPostingFlags()]);
        const summary = summariseConnection(row);
        if (!summary.connected) {
            res.status(409).json({ error: 'TikTok is not connected — connect it in Settings first.' });
            return;
        }
        const postMode = postModeFor(summary.canDirectPost, flags.directPostEnabled);
        if (postMode === 'inbox') {
            res.json({ postMode, audited: flags.audited, creator: null });
            return;
        }
        const { accessToken } = await getAccessToken(creatorId);
        const creator = await queryCreatorInfo(accessToken);
        res.json({ postMode, audited: flags.audited, creator });
    } catch (err) {
        if (err instanceof TikTokNotConnectedError) {
            res.status(409).json({ error: err.message });
            return;
        }
        log('warn', 'api.tiktok_creator_info_failed', describeError(err));
        res.status(502).json({ error: err instanceof Error ? err.message : 'TikTok did not answer.' });
    }
});

tiktokRouter.post('/connect', canAdminister, async (req, res) => {
    try {
        const app = await getTikTokAppConfig();
        if (!app) {
            res.status(409).json({ error: 'TikTok is not set up yet — add the TikTok client key and secret first.' });
            return;
        }
        const redirectUri = await redirectUriFor(req);
        if (!redirectUri) {
            res.status(409).json({ error: 'The public site address is not set — add it in the TikTok app settings.' });
            return;
        }
        const state = await createOAuthState(getTenantId(req), req.session?.userId ?? null);
        const { directPostEnabled } = await getTikTokPostingFlags();
        res.setHeader('Set-Cookie', stateCookie(state, Math.floor(OAUTH_STATE_TTL_MS / 1000)));
        res.json({
            url: buildAuthorizeUrl({ clientKey: app.clientKey, redirectUri, state, scopes: tiktokScopes(directPostEnabled) }),
        });
    } catch (err) {
        log('error', 'api.tiktok_connect_failed', describeError(err));
        res.status(500).json({ error: 'Failed to start the TikTok connection.' });
    }
});

tiktokRouter.post('/disconnect', canAdminister, async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const result = await disconnect(creatorId);
        if (!result.removed) {
            res.status(404).json({ error: 'TikTok is not connected.' });
            return;
        }
        await writeAudit(await actorFromSession(req.session), {
            action: AUDIT_ACTIONS.tiktokDisconnect,
            targetType: 'creator',
            targetId: creatorId,
            detail: { revoked_with_tiktok: result.revoked },
        });
        res.json({ success: true, revokedWithTikTok: result.revoked });
    } catch (err) {
        log('error', 'api.tiktok_disconnect_failed', describeError(err));
        res.status(500).json({ error: 'Failed to disconnect TikTok.' });
    }
});

tiktokRouter.get('/app-settings', requirePlatformAdmin, async (req, res) => {
    try {
        const [dbKey, dbSecret, baseUrl, verifyName, verifyContent, app, flags] = await Promise.all([
            getSetting(APP_SETTING_KEYS.tiktokClientKey),
            getSetting(APP_SETTING_KEYS.tiktokClientSecret),
            getSetting(APP_SETTING_KEYS.publicBaseUrl),
            getSetting(APP_SETTING_KEYS.tiktokVerificationFilename),
            getSetting(APP_SETTING_KEYS.tiktokVerificationContent),
            getTikTokAppConfig(),
            getTikTokPostingFlags(),
        ]);
        const base = await getPublicBaseUrl(requestOrigin(req));
        res.json({
            clientKey: {
                set: Boolean(app?.clientKey),
                source: app ? app.source.clientKey : null,
                // The client key is not a secret — TikTok puts it in every authorise URL — so
                // it is shown whole, which is what makes a typo findable.
                value: dbKey ?? (app?.source.clientKey === 'env' ? app.clientKey : null),
            },
            clientSecret: {
                set: Boolean(app?.clientSecret),
                source: app ? app.source.clientSecret : null,
                preview: dbSecret ? maskValue(dbSecret) : null,
            },
            publicBaseUrl: { saved: baseUrl, effective: base },
            verification: {
                filename: verifyName,
                set: Boolean(verifyName && verifyContent),
                url: verifyName && base ? `${base}/${verifyName}` : null,
            },
            // What to paste into TikTok's developer portal.
            register: base ? {
                redirectUri: `${base}${CALLBACK_PATH}`,
                webhookUrl: `${base}${WEBHOOK_PATH}`,
                termsUrl: `${base}/terms`,
                privacyUrl: `${base}/privacy`,
                websiteUrl: `${base}/`,
            } : null,
            scopes: tiktokScopes(flags.directPostEnabled),
            directPostEnabled: flags.directPostEnabled,
            audited: flags.audited,
        });
    } catch (err) {
        log('error', 'api.tiktok_app_settings_read_failed', describeError(err));
        res.status(500).json({ error: 'Failed to read TikTok app settings.' });
    }
});

/** TikTok's verification file name: `tiktok` + token + `.txt`, nothing that could be a path. */
export const VERIFICATION_FILENAME = /^tiktok[A-Za-z0-9_-]{4,100}\.txt$/;

tiktokRouter.post('/app-settings', requirePlatformAdmin, async (req, res) => {
    try {
        const body = req.body ?? {};
        const updatedBy = req.session?.userId ?? null;
        const changed: string[] = [];

        // Each field is optional: absent means "leave it", an empty string means "clear it".
        if (typeof body.clientKey === 'string') {
            const v = body.clientKey.trim();
            if (v && !/^[A-Za-z0-9_-]{6,100}$/.test(v)) {
                res.status(400).json({ error: 'That does not look like a TikTok client key.' });
                return;
            }
            await setSetting(APP_SETTING_KEYS.tiktokClientKey, v || null, updatedBy);
            changed.push('client_key');
        }
        if (typeof body.clientSecret === 'string') {
            const v = body.clientSecret.trim();
            if (v && (v.length < 10 || /\s/.test(v))) {
                res.status(400).json({ error: 'That does not look like a TikTok client secret.' });
                return;
            }
            await setSetting(APP_SETTING_KEYS.tiktokClientSecret, v || null, updatedBy);
            changed.push('client_credential');
        }
        if (typeof body.publicBaseUrl === 'string') {
            const raw = body.publicBaseUrl.trim();
            const v = raw ? normaliseOrigin(raw) : null;
            if (raw && !v) {
                res.status(400).json({ error: 'The site address must be an https:// URL, e.g. https://msg-response-auto.vercel.app' });
                return;
            }
            await setSetting(APP_SETTING_KEYS.publicBaseUrl, v, updatedBy);
            changed.push('public_base_url');
        }
        if (typeof body.verificationFilename === 'string' || typeof body.verificationContent === 'string') {
            const name = String(body.verificationFilename ?? '').trim();
            const content = String(body.verificationContent ?? '').trim();
            if ((name || content) && (!VERIFICATION_FILENAME.test(name) || !content || content.length > 500)) {
                res.status(400).json({ error: 'Paste both the file name TikTok gave you (tiktok….txt) and its contents.' });
                return;
            }
            await saveVerificationFile(name && content ? { filename: name, content } : null, updatedBy);
            changed.push('verification_file');
        }

        if (typeof body.directPostEnabled === 'boolean') {
            await setSetting(APP_SETTING_KEYS.tiktokDirectPostEnabled, body.directPostEnabled ? 'true' : null, updatedBy);
            changed.push('direct_post_enabled');
        }
        if (typeof body.audited === 'boolean') {
            await setSetting(APP_SETTING_KEYS.tiktokAudited, body.audited ? 'true' : null, updatedBy);
            changed.push('audited');
        }

        if (changed.length === 0) {
            res.status(400).json({ error: 'Nothing to save.' });
            return;
        }
        await writeAudit(await actorFromSession(req.session), {
            action: AUDIT_ACTIONS.settingsTikTokAppWrite,
            targetType: 'app',
            targetId: null,
            detail: { fields: changed },
        });
        res.json({ success: true, changed });
    } catch (err) {
        log('error', 'api.tiktok_app_settings_save_failed', describeError(err));
        res.status(500).json({ error: 'Failed to save TikTok app settings.' });
    }
});
