/**
 * Meta routes, under `/api/meta`: a tenant connects its own Facebook Page and Instagram account (docs/onboarding/04).
 * Two routers, as for TikTok and YouTube, because the callback is reached by Meta's redirect and can carry no session:
 *
 *   metaPublicRouter — mounted ABOVE `requireAuth` in api.ts
 *     GET  /callback        the Login redirect target; trusts only the single-use `state`, and the cookie that must equal it
 *     POST /deauthorize     Meta's Deauthorize Callback: a person removed the app; trusts only the HMAC of its `signed_request`
 *
 *   metaRouter — mounted BELOW `resolveTenant`, so every route acts as the session's tenant
 *     GET  /connection      the Settings card: is it enabled, is the app set up, and the tenant's connection (never a token)
 *     GET  /comment-check   operator: has a comment.process job arrived for this tenant since it connected? (the wizard's test comment)
 *     POST /connect         owner: mint a state, return the Login dialog's URL ({ returnTo?, reconnect?, authType? })
 *     GET  /candidates      owner: the Pages waiting for a choice, by ?pick= (names and ids, never a token)
 *     POST /select          owner: choose one ({ pick, pageId, facebookOnly?, confirmPageChange? })
 *     POST /disconnect      owner: unsubscribe the Page, delete the ids and the token ({ confirm: true })
 *     GET  /app-settings    platform admin: the switch, the configuration id, what to register in Meta's dashboard
 *     POST /app-settings    platform admin: save them
 *     GET  /webhooks        platform admin: where Meta sends each event type NOW (a live read of the app's subscriptions), the plan the button would apply, and when
 *                           an event of each kind last reached this workspace
 *     POST /webhooks/repair platform admin: send everything back to this deployment ({ confirm: true }); a step Meta refuses is that step's result, not an error
 *
 * What the callback does after the state is spent lives in `src/services/metaLogin.ts`; this file is cookies, redirects and
 * response shapes. FLOWS.md §8 walks the whole flow.
 *
 * Errors come in two shapes. The callback is a browser navigation, so it redirects to the dashboard with `meta=error&reason=…`
 * in the HASH query (where `App.hashParam` reads it). The JSON routes answer `{ error, code }` with the status the reason
 * carries (`MetaLoginError.httpStatus`), where `code` is the reason in upper case. Neither ever contains a token: errors from
 * Graph are wrapped and scrubbed in the service, and the responses here are built from fixed strings and ids.
 */
import express, { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from '../services/audit.js';
import { isPageId } from '../services/adminGuards.js';
import {
    APP_SETTING_KEYS, getMetaLoginSettings, getPublicBaseUrl, META_CONFIG_ID_PATTERN, setSetting,
} from '../services/appSettings.js';
import {
    consumeOAuthState, consumePick, createOAuthState, isReturnTo, NONCE_PATTERN, OAUTH_STATE_TTL_MS, readCookie, readPick,
    returnDestination, stateCookie as buildStateCookie, type OAuthReturnTo,
} from '../services/oauthState.js';
import {
    assertPageFree, buildLoginUrl, CALLBACK_PATH as META_CALLBACK_PATH, completeMetaConnection, CORE_SCOPES, disconnectMeta,
    ADS_SCOPES, finishLogin, getMetaConnection, isAuthType, loginAvailability, loginScopes, mayConnect, MetaLoginError, publicChoices,
    readIntent, readMetaApp, readPickPayload, replacesConnection, WEBHOOK_FIELDS,
} from '../services/metaLogin.js';
import { readCommentCheck } from '../services/metaCommentCheck.js';
import { checkMetaWebhooks, readLastEvents, repairSubscriptions, viewOf } from '../services/metaWebhooks.js';
import { DEAUTHORIZE_PATH, disconnectMetaUser, parseSignedRequest, SIGNED_REQUEST_MAX_CHARS } from '../services/metaDeauth.js';
import { appSecrets } from '../utils/signature.js';
import { describeError, log } from '../utils/log.js';

/** Carries the state through Meta's round trip so it can only complete in the browser that began it. */
export const STATE_COOKIE = 'meta_oauth_state';
export const CALLBACK_PATH = META_CALLBACK_PATH;

function stateCookie(value: string, maxAgeSeconds: number): string {
    return buildStateCookie(STATE_COOKIE, CALLBACK_PATH, value, maxAgeSeconds);
}

// ─── Where the browser goes back to ─────────────────────────────────────────────────────

/**
 * Back to the page that started the flow (`return_to` on the state: Settings, or the setup wizard's connect step; a state that was
 * never spent has no say: Settings), with the outcome in the HASH query (`#/settings?meta=…`), which is where the dashboard's
 * router reads it: a `?meta=` before the `#` is invisible to it. The state cookie is cleared on every way out.
 */
function backTo(res: Response, returnTo: OAuthReturnTo | null, outcome: 'connected' | 'error', extra: { reason?: string; warnings?: string[] } = {}): void {
    const params = new URLSearchParams({ meta: outcome });
    if (extra.reason) params.set('reason', extra.reason);
    if (extra.warnings?.length) params.set('warn', extra.warnings.join(','));
    res.setHeader('Set-Cookie', stateCookie('', 0));
    res.redirect(302, returnDestination(returnTo, params));
}

/** To the Page picker. The pick is a nonce bound to this tenant and user: opening it from another session finds nothing. */
function toPicker(res: Response, returnTo: OAuthReturnTo | null, pick: string): void {
    const params = new URLSearchParams({ meta: 'pick', pick });
    if (returnTo) params.set('return_to', returnTo);
    res.setHeader('Set-Cookie', stateCookie('', 0));
    res.redirect(302, `/dashboard#/connect-meta?${params.toString()}`);
}

/** The reason code the dashboard turns into a sentence. Anything that is not a `MetaLoginError` is an unexplained failure. */
function reasonOf(err: unknown): string {
    return err instanceof MetaLoginError ? err.reason : 'exchange_failed';
}

// ─── Public ─────────────────────────────────────────────────────────────────────────────

export const metaPublicRouter = Router();

metaPublicRouter.get('/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const denied = typeof req.query.error === 'string' ? req.query.error : '';
    let returnTo: OAuthReturnTo | null = null;

    try {
        const cookie = readCookie(req.headers.cookie, STATE_COOKIE);

        // The person pressed Cancel in the dialog, or Meta refused the request. The state is spent when it is ours (cookie and
        // state agree), which is also how the callback learns where to send the browser back to.
        if (denied) {
            if (state && NONCE_PATTERN.test(state) && cookie === state) {
                returnTo = (await consumeOAuthState(state, 'meta'))?.returnTo ?? null;
            }
            log('warn', 'meta.oauth_denied', { error: denied.slice(0, 40) });
            backTo(res, returnTo, 'error', { reason: denied === 'access_denied' ? 'denied' : 'meta_error' });
            return;
        }
        if (!state || !code) {
            backTo(res, null, 'error', { reason: 'missing_code' });
            return;
        }

        // The browser that started the flow holds the same value. A state lifted from a log or a referrer and completed
        // elsewhere fails here, before it is spent, so the attempt cannot burn the legitimate one.
        if (!cookie || cookie !== state) {
            log('warn', 'meta.oauth_state_mismatch', { browser_state: cookie ? 'different' : 'missing' });
            backTo(res, null, 'error', { reason: 'state_mismatch' });
            return;
        }

        const claim = NONCE_PATTERN.test(state) ? await consumeOAuthState(state, 'meta') : null;
        if (!claim) {
            backTo(res, null, 'error', { reason: 'state_expired' });
            return;
        }
        returnTo = claim.returnTo;

        const availability = await loginAvailability();
        if (!availability.enabled) {
            backTo(res, returnTo, 'error', { reason: 'disabled' });
            return;
        }
        const redirectUri = availability.redirectUri;
        if (!redirectUri) {
            backTo(res, returnTo, 'error', { reason: 'no_base_url' });
            return;
        }

        const outcome = await finishLogin({
            creatorId: claim.creatorId, userId: claim.userId, code, redirectUri,
            reconnect: readIntent(claim.payload).reconnect, returnTo,
        });
        if (outcome.kind === 'pick') {
            toPicker(res, returnTo, outcome.pick);
            return;
        }
        backTo(res, returnTo, 'connected', { warnings: outcome.result.warnings });
    } catch (err) {
        // A MetaLoginError's message is already scrubbed. Anything else is a database or code failure, which carries no token
        // either: the user token and the code exist only inside `finishLogin`, whose callers never receive them.
        log(err instanceof MetaLoginError ? 'warn' : 'error', 'meta.oauth_callback_failed', { reason: reasonOf(err), ...describeError(err) });
        backTo(res, returnTo, 'error', { reason: reasonOf(err) });
    }
});

/**
 * Meta's Deauthorize Callback (P33): a person removed the app from their Facebook account, and Meta tells us with a form POST of
 * `signed_request`. The only credential is that request's HMAC (`parseSignedRequest`), checked with every configured app secret before
 * anything is read from it. Every tenant that person connected is disconnected; a tenant nobody connected with that id is never touched,
 * and an id that matches no tenant is a 200 that does nothing (Meta would otherwise retry a request there is nothing to do for).
 *
 * The body is form-encoded, which the app-wide JSON parser does not read, so this route parses it itself, small. 400 for a request that is
 * not a signed request, 403 for one whose signature is not ours, 503 when there is no app secret to check with, 500 when a tenant could not
 * be cleared (Meta retries; the retry finds only what is left, because a cleared tenant no longer matches). Nothing about the request or the
 * person is logged: the reason, and how many secrets were tried, which is what tells a wrong secret from no deliveries.
 */
metaPublicRouter.post('/deauthorize', express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 20 }), async (req, res) => {
    try {
        const secrets = appSecrets();
        const raw = (req.body as { signed_request?: unknown } | undefined)?.signed_request;
        const parsed = parseSignedRequest(raw, { secrets });
        if (!parsed.ok) {
            log('warn', 'meta.deauthorize_rejected', {
                // Not `secrets_tried`: the logger redacts any key with "secret" in it, which would print "[redacted]" where the count belongs.
                reason: parsed.reason, app_keys_tried: parsed.secretsTried, has_signed_request: typeof raw === 'string' && raw.length > 0 && raw.length <= SIGNED_REQUEST_MAX_CHARS,
            });
            if (parsed.reason === 'no_secret') {
                res.status(503).json({ error: 'The Meta app secret is not configured.' });
                return;
            }
            res.status(parsed.reason === 'bad_signature' ? 403 : 400).json({ error: 'Invalid signed request.' });
            return;
        }

        const outcome = await disconnectMetaUser(parsed.userId);
        log('info', 'meta.deauthorize_handled', { matched: outcome.matched, disconnected: outcome.disconnected, failed: outcome.failed });
        if (outcome.failed > 0) {
            res.status(500).json({ error: 'Some connections could not be removed.' });
            return;
        }
        res.status(200).json({ received: true });
    } catch (err) {
        // A 5xx makes Meta try again, which is right when OUR side failed (the database); the request itself was already verified.
        log('error', 'meta.deauthorize_error', describeError(err));
        res.status(500).json({ error: 'Failed to process the deauthorization.' });
    }
});

// ─── Authenticated ──────────────────────────────────────────────────────────────────────

export const metaRouter = Router();

const canAdminister = requireTenantRole('owner');
const canObserve = requireTenantRole('operator');

function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): void {
    if (req.session?.role !== 'platform_admin') {
        res.status(404).json({ error: 'Not found.' });
        return;
    }
    next();
}

/** Answer a failure: a `MetaLoginError` with the status and code its reason carries, anything else as the given 500. */
function fail(res: Response, err: unknown, event: string, fallback: string): void {
    if (err instanceof MetaLoginError) {
        log('warn', event, { reason: err.reason, ...describeError(err) });
        res.status(err.httpStatus).json({ error: err.message, code: err.reason.toUpperCase() });
        return;
    }
    log('error', event, describeError(err));
    res.status(500).json({ error: fallback });
}

metaRouter.get('/connection', async (req, res) => {
    try {
        const [connection, availability] = await Promise.all([getMetaConnection(getTenantId(req)), loginAvailability()]);
        if (!connection) {
            res.status(404).json({ error: 'Not found.' });
            return;
        }
        res.json({
            enabled: availability.enabled,
            appConfigured: Boolean(availability.app),
            redirectUriConfigured: Boolean(availability.redirectUri),
            usesConfiguration: Boolean(availability.configId),
            connection,
        });
    } catch (err) {
        fail(res, err, 'api.meta_connection_read_failed', 'Failed to read the Meta connection.');
    }
});

/**
 * The wizard's test-comment check: has a `comment.process` job arrived for THIS tenant since it connected? A count and a time, never
 * what the comment said. Operator and up: it is polled by the wizard, which only an owner finishes, and by nobody else.
 */
metaRouter.get('/comment-check', canObserve, async (req, res) => {
    try {
        const check = await readCommentCheck(getTenantId(req));
        if (!check) {
            res.status(404).json({ error: 'Not found.' });
            return;
        }
        res.json(check);
    } catch (err) {
        fail(res, err, 'api.meta_comment_check_failed', 'Failed to check for the test comment.');
    }
});

metaRouter.post('/connect', canAdminister, async (req, res) => {
    try {
        const body = req.body ?? {};
        if (body.returnTo !== undefined && !isReturnTo(body.returnTo)) {
            res.status(400).json({ error: 'returnTo must be "settings" or "welcome".' });
            return;
        }
        if (body.authType !== undefined && body.authType !== null && !isAuthType(body.authType)) {
            res.status(400).json({ error: 'authType must be "rerequest" or "reauthorize".' });
            return;
        }
        const returnTo: OAuthReturnTo = body.returnTo ?? 'settings';
        const reconnect = body.reconnect === true;

        const availability = await loginAvailability();
        if (!availability.enabled) {
            res.status(409).json({ error: 'Connecting with Facebook is not switched on yet.', code: 'META_LOGIN_DISABLED' });
            return;
        }
        if (!availability.app) {
            res.status(409).json({ error: 'The Meta app is not configured: META_APP_ID and META_APP_SECRET are both needed.', code: 'NOT_CONFIGURED' });
            return;
        }
        if (!availability.redirectUri) {
            res.status(409).json({ error: 'The public site address (app.public_base_url) is not set: the Login redirect URI cannot be built without it.', code: 'NO_BASE_URL' });
            return;
        }

        const creatorId = getTenantId(req);
        // The first of two checks that an existing connection is never overwritten by accident. The callback makes the second.
        await mayConnect(creatorId, { reconnect });

        const state = await createOAuthState({
            purpose: 'meta', creatorId, userId: req.session?.userId ?? null, returnTo,
            payload: { v: 1, reconnect },
        });
        res.setHeader('Set-Cookie', stateCookie(state, Math.floor(OAUTH_STATE_TTL_MS / 1000)));
        res.json({
            url: buildLoginUrl({
                appId: availability.app.appId, redirectUri: availability.redirectUri, state,
                configId: availability.configId, authType: body.authType ?? null, adsScopes: availability.adsScopes,
            }),
        });
    } catch (err) {
        fail(res, err, 'api.meta_connect_failed', 'Failed to start the Meta connection.');
    }
});

metaRouter.get('/candidates', canAdminister, async (req, res) => {
    try {
        const pick = typeof req.query.pick === 'string' ? req.query.pick : '';
        const creatorId = getTenantId(req);
        // The tenant AND the user must be the ones who made it: another tenant's pick, or another user's, is simply not there.
        const state = await readPick(pick, creatorId, req.session?.userId ?? null);
        const payload = state ? readPickPayload(state.payload) : null;
        if (!state || !payload) {
            res.status(404).json({ error: 'Not found.' });
            return;
        }
        const connection = await getMetaConnection(creatorId);
        const current = connection?.connected ? { facebookPageId: connection.pageId, instagramPageId: connection.instagramId } : null;
        res.json({
            pick,
            expiresAt: new Date(state.expiresAt).toISOString(),
            returnTo: state.returnTo,
            connectedAs: { name: payload.metaUserName },
            reconnect: payload.reconnect,
            current: current ? { pageId: current.facebookPageId, instagramId: current.instagramPageId, pageName: connection?.pageName ?? null } : null,
            candidates: publicChoices(payload).map((c) => ({
                ...c,
                // Choosing it would replace a Page or Instagram account the tenant has now: the picker asks first.
                replaces: current !== null && replacesConnection(current, { facebookPageId: c.pageId, instagramPageId: c.instagram?.id ?? null }),
            })),
        });
    } catch (err) {
        fail(res, err, 'api.meta_candidates_failed', 'Failed to read the Pages.');
    }
});

metaRouter.post('/select', canAdminister, async (req, res) => {
    try {
        const body = req.body ?? {};
        const pick = typeof body.pick === 'string' ? body.pick : '';
        const creatorId = getTenantId(req);
        const userId = req.session?.userId ?? null;
        if (!isPageId(body.pageId)) {
            res.status(400).json({ error: 'pageId is required.', code: 'PAGE_UNUSABLE' });
            return;
        }

        // Everything that can be refused is refused BEFORE the pick is spent, so a mistake (a Page with no role, a missing
        // confirmation, a Page another tenant holds) leaves the choice standing. Only a failure that comes from Meta after
        // this point costs the person a second pass through the dialog.
        const state = await readPick(pick, creatorId, userId);
        const payload = state ? readPickPayload(state.payload) : null;
        if (!state || !payload) {
            res.status(404).json({ error: 'That choice has expired. Start again.', code: 'PICK_EXPIRED' });
            return;
        }
        const chosen = payload.choices.find((c) => c.pageId === body.pageId);
        if (!chosen || !chosen.usable || !chosen.accessToken) {
            res.status(400).json({ error: 'That Page is not one this account can manage.', code: 'PAGE_UNUSABLE' });
            return;
        }
        const facebookOnly = body.facebookOnly === true;
        if (!chosen.igId && !facebookOnly) {
            res.status(400).json({ error: 'That Page has no Instagram account linked. Link one, or choose to connect Facebook only.', code: 'INSTAGRAM_NOT_LINKED' });
            return;
        }
        const ids = { facebookPageId: chosen.pageId, instagramPageId: facebookOnly ? null : chosen.igId };
        const current = await mayConnect(creatorId, { reconnect: payload.reconnect });
        if (current.connected && replacesConnection(current, ids) && body.confirmPageChange !== true) {
            res.status(409).json({
                error: 'This replaces the connected Page or Instagram account with a different one. Confirm to continue.',
                code: 'PAGE_CHANGE_UNCONFIRMED',
            });
            return;
        }
        await assertPageFree(creatorId, ids);

        // The choice is made. One statement spends the pick AND nulls its payload: the Page tokens leave the table here.
        const spent = await consumePick(pick, creatorId, userId);
        const spentPayload = spent ? readPickPayload(spent.payload) : null;
        const token = spentPayload?.choices.find((c) => c.pageId === chosen.pageId)?.accessToken;
        if (!spent || !spentPayload || !token) {
            res.status(404).json({ error: 'That choice has expired. Start again.', code: 'PICK_EXPIRED' });
            return;
        }

        const result = await completeMetaConnection({
            creatorId, userId, metaUserId: spentPayload.metaUserId,
            choice: { pageId: chosen.pageId, name: chosen.name, accessToken: token, igId: chosen.igId, igUsername: chosen.igUsername },
            facebookOnly, reconnect: spentPayload.reconnect, confirmPageChange: body.confirmPageChange === true,
        });
        res.json({ success: true, result, returnTo: spent.returnTo });
    } catch (err) {
        fail(res, err, 'api.meta_select_failed', 'Failed to connect the Page.');
    }
});

metaRouter.post('/disconnect', canAdminister, async (req, res) => {
    try {
        // A disconnect empties the tenant's ids and token and unsubscribes its webhook: replies stop at once. An explicit
        // flag, so no stray request (a retry, a double click, a client that forgot) can do it.
        if (req.body?.confirm !== true) {
            res.status(400).json({ error: 'Disconnecting stops every reply on this account. Send { "confirm": true } to go ahead.', code: 'CONFIRMATION_REQUIRED' });
            return;
        }
        const { unsubscribed } = await disconnectMeta({ creatorId: getTenantId(req), userId: req.session?.userId ?? null });
        res.json({ success: true, unsubscribedFromWebhook: unsubscribed });
    } catch (err) {
        fail(res, err, 'api.meta_disconnect_failed', 'Failed to disconnect Meta.');
    }
});

metaRouter.get('/app-settings', requirePlatformAdmin, async (_req, res) => {
    try {
        const [settings, base] = await Promise.all([getMetaLoginSettings(), getPublicBaseUrl(null)]);
        const app = readMetaApp();
        res.json({
            enabled: settings.enabled,
            // Not a secret: it is in every dialog URL. Shown whole, so a typo is findable.
            configId: { set: Boolean(settings.configId), source: settings.configIdSource, value: settings.configId },
            // What the dialog uses: the configuration's permissions, or the scope list below.
            mode: settings.configId ? 'configuration' : 'scope',
            app: { idSet: Boolean(app), secretSet: Boolean(app) },
            publicBaseUrl: base,
            // What to register in Meta's dashboard: Facebook Login → Valid OAuth Redirect URIs, and the Deauthorize Callback URL (the same
            // settings page), which is how a person's removing the app disconnects their tenants here.
            register: base ? { redirectUri: `${base}${CALLBACK_PATH}`, deauthorizeUrl: `${base}${DEAUTHORIZE_PATH}` } : null,
            scopes: loginScopes(settings.adsScopesEnabled),
            // Connect also asks for the ads permissions (Boost). Only after the app has the Marketing API use case: see appSettings.ts.
            adsScopesEnabled: settings.adsScopesEnabled,
            adsScopes: [...ADS_SCOPES],
            coreScopes: [...CORE_SCOPES],
            webhookFields: [...WEBHOOK_FIELDS],
        });
    } catch (err) {
        fail(res, err, 'api.meta_app_settings_read_failed', 'Failed to read the Meta login settings.');
    }
});

metaRouter.post('/app-settings', requirePlatformAdmin, async (req, res) => {
    try {
        const body = req.body ?? {};
        const updatedBy = req.session?.userId ?? null;
        const changed: string[] = [];

        // Each field is optional: absent means "leave it", an empty string clears the id.
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
            res.status(400).json({ error: 'enabled must be true or false.' });
            return;
        }
        if (body.adsScopesEnabled !== undefined && typeof body.adsScopesEnabled !== 'boolean') {
            res.status(400).json({ error: 'adsScopesEnabled must be true or false.' });
            return;
        }
        if (body.configId !== undefined && typeof body.configId !== 'string') {
            res.status(400).json({ error: 'configId must be text.' });
            return;
        }
        const configId = typeof body.configId === 'string' ? body.configId.trim() : undefined;
        if (configId && !META_CONFIG_ID_PATTERN.test(configId)) {
            res.status(400).json({ error: 'That does not look like a Facebook Login for Business configuration id (digits only).' });
            return;
        }

        if (typeof body.enabled === 'boolean') {
            await setSetting(APP_SETTING_KEYS.metaLoginEnabled, body.enabled ? 'true' : null, updatedBy);
            changed.push('enabled');
        }
        if (configId !== undefined) {
            await setSetting(APP_SETTING_KEYS.metaLoginConfigId, configId || null, updatedBy);
            changed.push('config_id');
        }
        if (typeof body.adsScopesEnabled === 'boolean') {
            await setSetting(APP_SETTING_KEYS.metaAdsScopesEnabled, body.adsScopesEnabled ? 'true' : null, updatedBy);
            changed.push('ads_scopes_enabled');
        }
        if (changed.length === 0) {
            res.status(400).json({ error: 'Nothing to save.' });
            return;
        }
        await writeAudit(await actorFromSession(req.session), {
            action: AUDIT_ACTIONS.settingsMetaLoginWrite,
            targetType: 'app',
            targetId: null,
            detail: { fields: changed, enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined },
        });
        res.json({ success: true, changed });
    } catch (err) {
        fail(res, err, 'api.meta_app_settings_save_failed', 'Failed to save the Meta login settings.');
    }
});

// ─── Where Meta sends each kind of event (platform admin) ───────────────────────────────

/**
 * What the Settings card shows. A live read of the Meta app's subscriptions (`checkMetaWebhooks({ force: true })`, which also stores the answer the hourly check
 * and the banners read), judged against this deployment's own address, with the plan the button would apply and, for the acting workspace, when an event of each
 * kind last arrived. Meta not answering, or nothing to ask it with, is the status and code the service gives it (409 `NOT_CONFIGURED` / `NO_BASE_URL`, 502
 * `GRAPH_FAILED`): never a 401, which the dashboard reads as signed out. Platform admin only, and a 404 for anyone else, like the app settings beside it.
 */
metaRouter.get('/webhooks', requirePlatformAdmin, async (req, res) => {
    try {
        const result = await checkMetaWebhooks({ force: true });
        if (result.failure) {
            fail(res, result.failure, 'api.meta_webhooks_read_failed', 'Failed to read where Meta sends the events.');
            return;
        }
        if (!result.status) {
            res.status(500).json({ error: 'Failed to read where Meta sends the events.' });
            return;
        }
        // A quiet platform and a platform whose events go elsewhere look the same in `lastWebhookAt`, which is the newest of all of them: this is per platform.
        // A read that fails leaves the card without it.
        const lastEvents = await readLastEvents(getTenantId(req)).catch((err) => {
            log('warn', 'api.meta_webhooks_last_events_failed', describeError(err));
            return null;
        });
        res.json({ ...viewOf(result.status), lastEvents });
    } catch (err) {
        fail(res, err, 'api.meta_webhooks_read_failed', 'Failed to read where Meta sends the events.');
    }
});

/**
 * "Send everything to AutoReply": every Meta subscription that points elsewhere, is off or lacks a field is set back to this deployment, then each connected Page is
 * subscribed again if it needs it (`repairSubscriptions`). It rewrites where Meta sends events for the WHOLE Meta app, and another project using the app stops getting
 * the ones taken back, so it needs `{ "confirm": true }`: no retry, double click or client that forgot may do it. A step Meta refuses is reported in `steps` (200, `ok: false`,
 * Meta's own words): the dashboard treats a 401 as signed out, and a refusal by Meta is not that. Not configured, no public address and no verify token are 409s that
 * come before anything is sent. The write carries `canAdminister` too (a platform admin always acts as owner), because every mutating route here must carry a role guard;
 * it runs second, so anyone who is not a platform admin still gets the 404.
 */
metaRouter.post('/webhooks/repair', requirePlatformAdmin, canAdminister, async (req, res) => {
    try {
        if (req.body?.confirm !== true) {
            res.status(400).json({ error: 'This changes where Meta sends events for the whole Meta app. Send { "confirm": true } to go ahead.', code: 'CONFIRMATION_REQUIRED' });
            return;
        }
        const outcome = await repairSubscriptions(await actorFromSession(req.session));
        res.json({
            success: true,
            steps: outcome.steps,
            pages: outcome.pages,
            before: outcome.before,
            // False: the subscriptions could not be read back, so `objects` below is what was known before the change, not what Meta says now.
            confirmed: outcome.after !== null,
            ...viewOf(outcome.status),
        });
    } catch (err) {
        fail(res, err, 'api.meta_webhooks_repair_failed', 'Failed to send the events to AutoReply.');
    }
});
