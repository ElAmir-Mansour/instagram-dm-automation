/**
 * YouTube routes, under `/api/youtube`. Two routers, as for TikTok:
 *
 *   youtubePublicRouter — mounted ABOVE `requireAuth` in api.ts
 *     GET  /callback       Google's OAuth redirect; trusts only the single-use `state` + its cookie
 *
 *   youtubeRouter — mounted BELOW `resolveTenant`
 *     GET  /connection     the Settings card: the channel, whether the app is set up, public or private uploads
 *     POST /connect        owner: mint a state, return Google's consent URL
 *     POST /disconnect     owner: revoke with Google and delete the tokens
 *     GET  /app-settings   platform admin: the OAuth client's status and the URLs to register
 *     POST /app-settings   platform admin: save the client ID / secret and the public-uploads switch
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from '../services/audit.js';
import {
    APP_SETTING_KEYS, getPublicBaseUrl, getSetting, getYouTubeAppConfig, maskValue, setSetting, youtubeUploadsPublic,
} from '../services/appSettings.js';
import { buildAuthorizeUrl, YOUTUBE_SCOPES, YouTubeApiError } from '../services/youtube.js';
import {
    completeConnection, consumeOAuthState, createOAuthState, disconnect, getConnection, OAUTH_STATE_TTL_MS,
    summariseConnection, YouTubeChannelInUseError,
} from '../services/youtubeConnections.js';
import { readCookie } from './tiktok.js';
import { describeError, log } from '../utils/log.js';

export const STATE_COOKIE = 'youtube_oauth_state';
export const CALLBACK_PATH = '/api/youtube/callback';

/** A Google OAuth client ID: `<project number>-<id>.apps.googleusercontent.com`. */
export const CLIENT_ID_PATTERN = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

function requestOrigin(req: Request): string | null {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0]!.trim();
    const host = req.get('host');
    return host ? `${proto}://${host}` : null;
}

/** Built from `app.public_base_url`, never the Host header: Google matches it byte for byte. */
export async function redirectUriFor(req: Request): Promise<string | null> {
    const base = await getPublicBaseUrl(requestOrigin(req));
    return base ? `${base}${CALLBACK_PATH}` : null;
}

function stateCookie(value: string, maxAgeSeconds: number): string {
    // Lax: the callback is a top-level navigation from accounts.google.com.
    return `${STATE_COOKIE}=${encodeURIComponent(value)}; Path=${CALLBACK_PATH}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

/** Back to Settings with an outcome in the HASH query, where the dashboard's router reads it. */
function backToSettings(res: Response, outcome: 'connected' | 'error', reason?: string): void {
    const params = new URLSearchParams({ youtube: outcome });
    if (reason) params.set('reason', reason);
    res.setHeader('Set-Cookie', stateCookie('', 0));
    res.redirect(302, `/dashboard#/settings?${params.toString()}`);
}

/** The reason code the Settings toast explains, from whatever the exchange threw. */
export function callbackFailureReason(err: unknown): string {
    if (err instanceof YouTubeChannelInUseError) return 'channel_in_use';
    if (err instanceof YouTubeApiError && err.reason === 'youtubeSignupRequired') return 'no_channel';
    if (err instanceof YouTubeApiError && (err.reason === 'insufficientPermissions' || err.httpStatus === 403)) return 'scope_missing';
    if (err instanceof YouTubeApiError && err.reason === 'redirect_uri_mismatch') return 'redirect_mismatch';
    if (err instanceof YouTubeApiError && err.reason === 'invalid_client') return 'bad_client';
    return 'exchange_failed';
}

// ─── Public ─────────────────────────────────────────────────────────────────────────────

export const youtubePublicRouter = Router();

youtubePublicRouter.get('/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const denied = typeof req.query.error === 'string' ? req.query.error : '';
    try {
        if (denied) {
            log('warn', 'youtube.oauth_denied', { error: denied });
            backToSettings(res, 'error', denied === 'access_denied' ? 'denied' : 'google_error');
            return;
        }
        if (!state || !code) {
            backToSettings(res, 'error', 'missing_code');
            return;
        }
        const cookie = readCookie(req.headers.cookie, STATE_COOKIE);
        if (!cookie || cookie !== state) {
            log('warn', 'youtube.oauth_state_mismatch', { has_cookie: Boolean(cookie) });
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
        const connection = await completeConnection({ creatorId: claim.creatorId, userId: claim.userId, code, redirectUri });
        await writeAudit(await actorFromSession({ userId: claim.userId }), {
            action: AUDIT_ACTIONS.youtubeConnect,
            targetType: 'creator',
            targetId: claim.creatorId,
            // The id, not the channel's name: the audit log is never cleared, and YouTube's policies let
            // an identifier be kept where they do not let the rest of the channel's data be.
            detail: { channel_id: connection.external_account_id, scopes: connection.scopes },
        });
        log('info', 'youtube.connected', { creator_id: claim.creatorId, channel_id: connection.external_account_id });
        backToSettings(res, 'connected');
    } catch (err) {
        log('error', 'youtube.oauth_callback_failed', describeError(err));
        backToSettings(res, 'error', callbackFailureReason(err));
    }
});

// ─── Authenticated ──────────────────────────────────────────────────────────────────────

export const youtubeRouter = Router();

const canAdminister = requireTenantRole('owner');

function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): void {
    if (req.session?.role !== 'platform_admin') {
        res.status(404).json({ error: 'Not found.' });
        return;
    }
    next();
}

youtubeRouter.get('/connection', async (req, res) => {
    try {
        const [row, app, publicUploads] = await Promise.all([getConnection(getTenantId(req)), getYouTubeAppConfig(), youtubeUploadsPublic()]);
        res.json({ appConfigured: Boolean(app), publicUploads, connection: summariseConnection(row) });
    } catch (err) {
        log('error', 'api.youtube_connection_read_failed', describeError(err));
        res.status(500).json({ error: 'Failed to read the YouTube connection.' });
    }
});

youtubeRouter.post('/connect', canAdminister, async (req, res) => {
    try {
        const app = await getYouTubeAppConfig();
        if (!app) {
            res.status(409).json({ error: 'YouTube is not set up yet — add the Google OAuth client ID and secret first.' });
            return;
        }
        const redirectUri = await redirectUriFor(req);
        if (!redirectUri) {
            res.status(409).json({ error: 'The public site address is not set — add it in the TikTok app settings.' });
            return;
        }
        const state = await createOAuthState(getTenantId(req), req.session?.userId ?? null);
        res.setHeader('Set-Cookie', stateCookie(state, Math.floor(OAUTH_STATE_TTL_MS / 1000)));
        res.json({ url: buildAuthorizeUrl({ clientId: app.clientId, redirectUri, state }) });
    } catch (err) {
        log('error', 'api.youtube_connect_failed', describeError(err));
        res.status(500).json({ error: 'Failed to start the YouTube connection.' });
    }
});

youtubeRouter.post('/disconnect', canAdminister, async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const result = await disconnect(creatorId);
        if (!result.removed) {
            res.status(404).json({ error: 'YouTube is not connected.' });
            return;
        }
        await writeAudit(await actorFromSession(req.session), {
            action: AUDIT_ACTIONS.youtubeDisconnect,
            targetType: 'creator',
            targetId: creatorId,
            detail: { revoked_with_google: result.revoked },
        });
        res.json({ success: true, revokedWithGoogle: result.revoked });
    } catch (err) {
        log('error', 'api.youtube_disconnect_failed', describeError(err));
        res.status(500).json({ error: 'Failed to disconnect YouTube.' });
    }
});

youtubeRouter.get('/app-settings', requirePlatformAdmin, async (req, res) => {
    try {
        const [dbId, dbSecret, app, publicUploads, base] = await Promise.all([
            getSetting(APP_SETTING_KEYS.youtubeClientId),
            getSetting(APP_SETTING_KEYS.youtubeClientSecret),
            getYouTubeAppConfig(),
            youtubeUploadsPublic(),
            getPublicBaseUrl(requestOrigin(req)),
        ]);
        res.json({
            clientId: {
                set: Boolean(app?.clientId),
                source: app ? app.source.clientId : null,
                // Not a secret: Google puts it in every consent URL. Shown whole, so a typo is findable.
                value: dbId ?? (app?.source.clientId === 'env' ? app.clientId : null),
            },
            clientSecret: {
                set: Boolean(app?.clientSecret),
                source: app ? app.source.clientSecret : null,
                preview: dbSecret ? maskValue(dbSecret) : null,
            },
            publicUploads,
            // What to enter in Google Cloud: the OAuth client and the consent screen.
            register: base ? {
                redirectUri: `${base}${CALLBACK_PATH}`,
                homepageUrl: `${base}/`,
                privacyUrl: `${base}/privacy`,
                termsUrl: `${base}/terms`,
            } : null,
            scopes: [...YOUTUBE_SCOPES],
        });
    } catch (err) {
        log('error', 'api.youtube_app_settings_read_failed', describeError(err));
        res.status(500).json({ error: 'Failed to read YouTube app settings.' });
    }
});

youtubeRouter.post('/app-settings', requirePlatformAdmin, async (req, res) => {
    try {
        const body = req.body ?? {};
        const updatedBy = req.session?.userId ?? null;
        const changed: string[] = [];
        // Absent means "leave it", an empty string means "clear it".
        if (typeof body.clientId === 'string') {
            const v = body.clientId.trim();
            if (v && !CLIENT_ID_PATTERN.test(v)) {
                res.status(400).json({ error: 'That does not look like a Google OAuth client ID (…apps.googleusercontent.com).' });
                return;
            }
            await setSetting(APP_SETTING_KEYS.youtubeClientId, v || null, updatedBy);
            changed.push('client_id');
        }
        if (typeof body.clientSecret === 'string') {
            const v = body.clientSecret.trim();
            if (v && (v.length < 10 || /\s/.test(v))) {
                res.status(400).json({ error: 'That does not look like a Google OAuth client secret.' });
                return;
            }
            await setSetting(APP_SETTING_KEYS.youtubeClientSecret, v || null, updatedBy);
            changed.push('client_credential');
        }
        if (typeof body.publicUploads === 'boolean') {
            await setSetting(APP_SETTING_KEYS.youtubePublicUploads, body.publicUploads ? 'true' : null, updatedBy);
            changed.push('public_uploads');
        }
        if (changed.length === 0) {
            res.status(400).json({ error: 'Nothing to save.' });
            return;
        }
        await writeAudit(await actorFromSession(req.session), {
            action: AUDIT_ACTIONS.settingsYouTubeAppWrite,
            targetType: 'app',
            targetId: null,
            detail: { fields: changed },
        });
        res.json({ success: true, changed });
    } catch (err) {
        log('error', 'api.youtube_app_settings_save_failed', describeError(err));
        res.status(500).json({ error: 'Failed to save YouTube app settings.' });
    }
});
