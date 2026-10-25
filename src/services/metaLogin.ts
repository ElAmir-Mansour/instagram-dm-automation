/**
 * Connecting a tenant's own Facebook Page and Instagram account: Facebook Login for Business (docs/onboarding/04).
 *
 * Until now a Meta connection was a page id and a PAGE access token the operator pasted. This is the same connection made with
 * clicks: the tenant's owner presses Connect, approves a dialog, and this module turns the `code` Meta sends back into a Page
 * token with no expiry date, checks it, subscribes the Page to the app's webhook and stores it (`creators`, exactly the columns a
 * pasted token fills, plus what v35 added). Every Graph call after the connection is made keeps working unchanged, because the
 * result is the same kind of token on the same host.
 *
 *   1. `buildLoginUrl`    the dialog URL: the operator's configuration id (a setting), or a plain `scope=` list without one.
 *   2. `finishLogin`      the callback's work: code → short-lived user token → long-lived user token → who the user is, what they
 *                         granted, and their Pages with each Page's token and linked Instagram account. One usable Page with
 *                         Instagram connects at once; anything else waits for a choice (`meta_pick`, ten minutes, encrypted).
 *   3. `completeMetaConnection`   the one place a connection is written (below).
 *   4. `disconnectMeta`   unsubscribe, then clear the ids and the token.
 *
 * Three rules this module keeps, because the owner's tenant is connected today with a never-expiring token and the webhook for
 * his Page is live:
 *
 *   - **Nothing overwrites a connection by accident.** A tenant that already has a Meta token is only reconnected when its owner
 *     said so when starting the flow (the state carries `reconnect`), and a reconnect that lands on DIFFERENT ids needs a second,
 *     explicit confirmation (campaigns tied to the old Page's post ids stop matching). Checked at the start, again at the end.
 *   - **A Page belongs to one tenant.** Checked before Meta is asked to subscribe it, so a tenant cannot take over a Page's
 *     webhook from another; a unique-index violation at the write is the same answer. The other tenant is never named to this one.
 *   - **No secret leaves.** A token, a code or the app secret never reaches a log line, a response, an audit row or a URL we
 *     build: Graph calls carry tokens in the `Authorization` header, and every error that leaves this module is a `MetaLoginError`
 *     whose message has been through `scrubSecrets` (no axios error, with its request config, ever escapes).
 */
import { pool } from '../config/db.js';
import { encryptSecret } from '../config/crypto.js';
import { queryCount, queryOne } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import { getMetaLoginSettings, getPublicBaseUrl } from './appSettings.js';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from './audit.js';
import { metaHttp, metaErrorCode, metaErrorSubcode, withRetry } from './http.js';
import { API_VERSION, GRAPH_BASE } from './instagram.js';
import { createOAuthState, type OAuthReturnTo } from './oauthState.js';
import { getTenant, invalidateTenantCache } from './tenant.js';
import { captureAdsAccess, forgetConnectedAdsAccess } from './adBoosts.js';
import { activeSignoff } from './ads/legalSignoff.js';
import { inspectionStatus, inspectToken, REQUIRED_SCOPES, type TokenInspection } from './tokenHealth.js';

// ─── What we ask Meta for ───────────────────────────────────────────────────────────────

/**
 * The permissions the Login configuration must grant, and what the dialog asks for when there is no configuration: everything
 * the app's own paths need (`REQUIRED_SCOPES`) plus the two the Growth insights need.
 */
export const LOGIN_SCOPES: readonly string[] = [...new Set([...REQUIRED_SCOPES, 'instagram_manage_insights', 'read_insights'])];

/**
 * What Boost needs (docs/META_ADS_RESEARCH.md): asked for on top of LOGIN_SCOPES only when `meta.ads_scopes_enabled` is on, and never
 * required. A person who grants them gets the ads token stored for their tenant (`captureAdsAccess`); one who declines connects as before.
 */
export const ADS_SCOPES: readonly string[] = ['ads_read', 'ads_management', 'business_management'];

/** What the dialog asks for in `scope=` mode. */
export function loginScopes(adsScopes: boolean): string[] {
    return adsScopes ? [...new Set([...LOGIN_SCOPES, ...ADS_SCOPES])] : [...LOGIN_SCOPES];
}

/**
 * What a connection cannot work without. A user who declined any of these is not connected (a connection that reads no comments
 * is worse than none: it looks connected). Any other declined permission connects anyway, with a warning naming what is lost.
 */
export const CORE_SCOPES: readonly string[] = ['pages_show_list', 'pages_manage_metadata', 'instagram_basic', 'instagram_manage_comments'];

/**
 * The Page-level webhook fields the Page is subscribed to (`POST /{page}/subscribed_apps`). Instagram comments arrive on the app-level subscription.
 * `messaging_referrals` (A3): a person who already has a Messenger thread and taps a click-to-message ad is announced ONLY by a standalone referral
 * event on this field (a new thread's referral rides on `messaging_postbacks`, Instagram's on `messages`). The App Dashboard's Page webhook needs the
 * field too; `scripts/diagnose.mjs` checks it.
 */
export const WEBHOOK_FIELDS: readonly string[] = ['feed', 'messages', 'messaging_postbacks', 'messaging_referrals'];

/** What each optional permission pays for, as stable codes the dashboard turns into words. */
export const SCOPE_FEATURES: Readonly<Record<string, string>> = {
    instagram_manage_messages: 'instagram_dms',
    instagram_content_publish: 'instagram_publishing',
    pages_messaging: 'facebook_dms',
    pages_manage_engagement: 'facebook_comment_replies',
    pages_manage_posts: 'facebook_publishing',
    pages_read_engagement: 'facebook_insights',
    pages_read_user_content: 'facebook_comments',
    business_management: 'business_assets',
    instagram_manage_insights: 'instagram_insights',
    read_insights: 'facebook_insights',
};

/** The features a set of missing permissions turns off, without repeats. */
export function affectedFeatures(missingScopes: readonly string[]): string[] {
    return [...new Set(missingScopes.map((s) => SCOPE_FEATURES[s]).filter((f): f is string => Boolean(f)))];
}

/** A "reconnect due" nudge starts this long before Instagram's 90-day data access lapses (docs/onboarding/04 §2, Token health). */
export const RECONNECT_DUE_DAYS = 14;

// ─── Errors, and keeping secrets out of them ───────────────────────────────────────────

export type MetaLoginReason =
    | 'not_configured'          // META_APP_ID / META_APP_SECRET missing
    | 'disabled'                // the operator's switch is off
    | 'no_base_url'             // app.public_base_url unset: no redirect URI can be built
    | 'code_exchange_failed'    // Meta refused the code (expired, already used, redirect URI mismatch)
    | 'token_exchange_failed'   // Meta refused the long-lived exchange
    | 'graph_failed'            // a read after the exchange failed
    | 'not_tester'              // nothing was granted: the person holds no role on the app (unverified, docs/onboarding/04 §4)
    | 'permissions_missing'     // a core permission was declined
    | 'no_pages'                // the user manages no Page
    | 'page_unusable'           // the chosen Page is not one the user can manage, or is not on the list
    | 'instagram_not_linked'    // the chosen Page has no Instagram account, and Facebook-only was not asked for
    | 'token_invalid'           // debug_token refused the Page token, or it is not a PAGE token
    | 'page_in_use'             // another tenant holds this Page or Instagram account
    | 'already_connected'       // the tenant has a connection and its owner did not ask for a reconnect
    | 'page_change_unconfirmed' // a reconnect to different ids, not confirmed
    | 'encryption_unavailable'  // TOKEN_ENCRYPTION_KEY is not set
    | 'pick_expired'            // the Page pick is gone: expired, spent, or someone else's
    | 'tenant_not_found'
    | 'not_connected';          // disconnect: there is nothing to disconnect

const HTTP_STATUS: Record<MetaLoginReason, number> = {
    not_configured: 409, disabled: 409, no_base_url: 409,
    code_exchange_failed: 400, token_exchange_failed: 502, graph_failed: 502,
    not_tester: 403, permissions_missing: 409, no_pages: 409,
    page_unusable: 400, instagram_not_linked: 400, token_invalid: 400,
    page_in_use: 409, already_connected: 409, page_change_unconfirmed: 409,
    encryption_unavailable: 500, pick_expired: 404, tenant_not_found: 404, not_connected: 404,
};

/**
 * A failure of the Meta connection flow. `reason` is the stable code the callback puts in the redirect and the routes put in the
 * response; the message has been scrubbed of secrets. Carries no `response`, no `config` and no `cause`: nothing a logger could
 * walk into finds a token.
 */
export class MetaLoginError extends Error {
    readonly reason: MetaLoginReason;
    readonly httpStatus: number;
    readonly metaCode: number | undefined;
    readonly metaSubcode: number | undefined;

    constructor(reason: MetaLoginReason, message: string, extra: { metaCode?: number; metaSubcode?: number; secrets?: readonly (string | null | undefined)[] } = {}) {
        super(scrubSecrets(message, extra.secrets));
        this.name = 'MetaLoginError';
        this.reason = reason;
        this.httpStatus = HTTP_STATUS[reason];
        this.metaCode = extra.metaCode;
        this.metaSubcode = extra.metaSubcode;
    }
}

const QUERY_SECRET = /\b(access_token|client_secret|fb_exchange_token|input_token|appsecret_proof|code)=([^&\s"'<>]+)/gi;
/** Meta access tokens all begin `EAA`. */
const META_TOKEN = /\bEAA[A-Za-z0-9]{16,}/g;
/** Anything this long and this uniform is a token, a code or a ciphertext, whatever it starts with. */
const OPAQUE_RUN = /[A-Za-z0-9_-]{60,}/g;

/**
 * Take every secret out of a piece of text before it is logged, stored or returned: the values this call knows about, exactly;
 * `name=value` pairs for the parameters Meta takes secrets in; anything shaped like a Meta access token; any long opaque run.
 * Errors from Graph are the realistic carrier (a message that echoes the request), so it is applied wherever one is wrapped.
 */
export function scrubSecrets(text: string, known: readonly (string | null | undefined)[] = []): string {
    let out = String(text);
    for (const secret of known) {
        if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]');
    }
    return out
        .replace(QUERY_SECRET, '$1=[redacted]')
        .replace(META_TOKEN, '[redacted]')
        .replace(OPAQUE_RUN, '[redacted]');
}

/** Wrap anything thrown by a Graph call: the Meta error's message and codes, scrubbed, and nothing else of the request. */
function graphError(reason: MetaLoginReason, label: string, err: unknown, secrets: readonly (string | null | undefined)[]): MetaLoginError {
    const metaMessage = (err as any)?.response?.data?.error?.message;
    const detail = typeof metaMessage === 'string' ? metaMessage : String((err as any)?.message ?? 'no answer');
    return new MetaLoginError(reason, `${label}: ${detail}`, {
        metaCode: metaErrorCode(err), metaSubcode: metaErrorSubcode(err), secrets,
    });
}

// ─── The app, and the dialog ────────────────────────────────────────────────────────────

export interface MetaApp { appId: string; appSecret: string }

/** The Meta app's id and secret: the same pair the webhook signature and `debug_token` use. Null when either is missing. */
export function readMetaApp(env: NodeJS.ProcessEnv = process.env): MetaApp | null {
    const appId = env.META_APP_ID?.trim();
    const appSecret = env.META_APP_SECRET?.trim();
    return appId && appSecret ? { appId, appSecret } : null;
}

export const CALLBACK_PATH = '/api/meta/callback';

/**
 * The redirect URI Meta matches byte for byte against "Valid OAuth Redirect URIs": the `app.public_base_url` setting (or
 * `PUBLIC_BASE_URL`) and nothing else. Not the request's Host header, which TikTok's and YouTube's routes tolerate as a last resort:
 * a Host-derived URI would differ on every preview deployment, and a login that fails on a mismatch is better stopped here, naming
 * the missing setting, than at Meta.
 */
export async function metaRedirectUri(): Promise<string | null> {
    const base = await getPublicBaseUrl(null);
    return base ? `${base}${CALLBACK_PATH}` : null;
}

export type AuthType = 'rerequest' | 'reauthorize';

export function isAuthType(value: unknown): value is AuthType {
    return value === 'rerequest' || value === 'reauthorize';
}

/**
 * The Login dialog's URL. With a configuration id the permissions come from the configuration, and Meta returns an authorization
 * `code` (`response_type=code`; `override_default_response_type` is what makes a Business Login configuration honour it). Without
 * one, `scope=` lists what we need, which works for people with a role on the app. `authType` is a reconnect: `rerequest` asks
 * again for permissions that were declined, `reauthorize` renews Instagram's 90-day data access.
 */
export function buildLoginUrl(input: { appId: string; redirectUri: string; state: string; configId: string | null; authType?: AuthType | null; adsScopes?: boolean }): string {
    const params = new URLSearchParams({
        client_id: input.appId,
        redirect_uri: input.redirectUri,
        state: input.state,
        response_type: 'code',
    });
    if (input.configId) {
        params.set('config_id', input.configId);
        params.set('override_default_response_type', 'true');
    } else {
        params.set('scope', loginScopes(input.adsScopes === true).join(','));
    }
    if (input.authType) params.set('auth_type', input.authType);
    return `https://www.facebook.com/${API_VERSION}/dialog/oauth?${params.toString()}`;
}

/** Whether the tenant may start the flow now, and with what: the checks `POST /connect` makes before it mints a state. */
export interface LoginAvailability {
    enabled: boolean;
    adsScopes: boolean;
    app: MetaApp | null;
    configId: string | null;
    redirectUri: string | null;
}

export async function loginAvailability(): Promise<LoginAvailability> {
    const [settings, redirectUri] = await Promise.all([getMetaLoginSettings(), metaRedirectUri()]);
    return { enabled: settings.enabled, adsScopes: settings.adsScopesEnabled, app: readMetaApp(), configId: settings.configId, redirectUri };
}

// ─── Graph: the exchange and the reads ──────────────────────────────────────────────────

interface GraphGetOptions {
    reason: MetaLoginReason;
    /** The bearer token, sent in the Authorization header and never in the URL. */
    token?: string;
    params?: Record<string, string | number>;
    secrets: readonly (string | null | undefined)[];
    /** Reads and the long-lived exchange are safe to repeat. The code exchange is not: a code is single-use. */
    retry: boolean;
}

async function graphGet<T>(label: string, path: string, opts: GraphGetOptions): Promise<T> {
    const call = () => metaHttp.get(`${GRAPH_BASE}${path}`, {
        params: opts.params,
        headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : undefined,
    });
    try {
        const response = opts.retry ? await withRetry(call, { label, retries: 2, baseMs: 400 }) : await call();
        return response.data as T;
    } catch (err) {
        throw graphError(opts.reason, label, err, opts.secrets);
    }
}

function tokenFrom(data: unknown, label: string, reason: MetaLoginReason, secrets: readonly (string | null | undefined)[]): string {
    const token = (data as { access_token?: unknown } | null)?.access_token;
    if (typeof token !== 'string' || !token) throw new MetaLoginError(reason, `${label}: Meta answered without a token.`, { secrets });
    return token;
}

/** The authorization `code` for a short-lived USER token. Not retried: a code is single-use, so a retry after a timeout would meet "already used". */
export async function exchangeCode(app: MetaApp, code: string, redirectUri: string): Promise<string> {
    const secrets = [app.appSecret, code];
    const data = await graphGet<unknown>('meta.exchange_code', '/oauth/access_token', {
        reason: 'code_exchange_failed', retry: false, secrets,
        params: { client_id: app.appId, client_secret: app.appSecret, redirect_uri: redirectUri, code },
    });
    return tokenFrom(data, 'meta.exchange_code', 'code_exchange_failed', secrets);
}

/** A short-lived USER token for a long-lived one (about 60 days): the token whose Pages carry Page tokens with no expiry date. */
export async function extendUserToken(app: MetaApp, shortToken: string): Promise<string> {
    const secrets = [app.appSecret, shortToken];
    const data = await graphGet<unknown>('meta.extend_user_token', '/oauth/access_token', {
        reason: 'token_exchange_failed', retry: true, secrets,
        params: { grant_type: 'fb_exchange_token', client_id: app.appId, client_secret: app.appSecret, fb_exchange_token: shortToken },
    });
    return tokenFrom(data, 'meta.extend_user_token', 'token_exchange_failed', secrets);
}

export interface MetaIdentity { id: string; name: string | null }

export async function readIdentity(userToken: string): Promise<MetaIdentity> {
    const data = await graphGet<{ id?: unknown; name?: unknown }>('meta.read_identity', '/me', {
        reason: 'graph_failed', retry: true, token: userToken, secrets: [userToken], params: { fields: 'id,name' },
    });
    if (typeof data?.id !== 'string' || !data.id) throw new MetaLoginError('graph_failed', 'meta.read_identity: Meta did not say who authorised.');
    return { id: data.id, name: typeof data.name === 'string' ? data.name : null };
}

/** `/me/permissions`: which permissions this user granted the app, and which they declined. */
export async function readPermissions(userToken: string): Promise<{ granted: string[]; declined: string[] }> {
    const data = await graphGet<{ data?: Array<{ permission?: unknown; status?: unknown }> }>('meta.read_permissions', '/me/permissions', {
        reason: 'graph_failed', retry: true, token: userToken, secrets: [userToken],
    });
    const granted: string[] = [];
    const declined: string[] = [];
    for (const row of Array.isArray(data?.data) ? data.data : []) {
        if (typeof row?.permission !== 'string') continue;
        if (row.status === 'granted') granted.push(row.permission);
        else declined.push(row.permission);
    }
    return { granted, declined };
}

/** One Page the user can reach, as Meta lists it. The token is the Page's own: server-side only. */
export interface RawPage {
    pageId: string;
    name: string;
    accessToken: string | null;
    tasks: string[];
    igId: string | null;
    igUsername: string | null;
}

const PAGE_FIELDS = 'id,name,access_token,tasks,instagram_business_account{id,username}';
/** 100 per request, and a cap on requests: a person with more than 1,000 Pages is not a tenant. */
const MAX_PAGE_REQUESTS = 10;

/**
 * `/me/accounts`: every Page the user manages, each with its Page access token and linked Instagram business account. Follows
 * the paging CURSOR with the same Authorization header rather than Meta's `paging.next`, which is a URL with the user token in it.
 */
export async function listPages(userToken: string): Promise<RawPage[]> {
    const pages: RawPage[] = [];
    let after: string | undefined;
    for (let request = 0; request < MAX_PAGE_REQUESTS; request++) {
        const params: Record<string, string | number> = { fields: PAGE_FIELDS, limit: 100 };
        if (after) params.after = after;
        const data = await graphGet<{
            data?: Array<Record<string, any>>;
            paging?: { cursors?: { after?: unknown }; next?: unknown };
        }>('meta.list_pages', '/me/accounts', { reason: 'graph_failed', retry: true, token: userToken, secrets: [userToken], params });

        for (const row of Array.isArray(data?.data) ? data.data : []) {
            if (typeof row?.id !== 'string' || !row.id) continue;
            const ig = row.instagram_business_account;
            pages.push({
                pageId: row.id,
                name: typeof row.name === 'string' ? row.name : row.id,
                accessToken: typeof row.access_token === 'string' && row.access_token ? row.access_token : null,
                tasks: Array.isArray(row.tasks) ? row.tasks.filter((t: unknown): t is string => typeof t === 'string') : [],
                igId: typeof ig?.id === 'string' && ig.id ? ig.id : null,
                igUsername: typeof ig?.username === 'string' && ig.username ? ig.username.toLowerCase() : null,
            });
        }
        const next = data?.paging?.next ? data?.paging?.cursors?.after : undefined;
        if (typeof next !== 'string' || !next) break;
        after = next;
    }
    return pages;
}

// ─── Which Page ─────────────────────────────────────────────────────────────────────────

/** A Page as the picker shows it. `accessToken` is set for a usable Page only, and never leaves the server. */
export interface PageChoice {
    pageId: string;
    name: string;
    igId: string | null;
    igUsername: string | null;
    usable: boolean;
    /** Why a Page is shown disabled: the user holds no role on it that can publish and moderate. */
    unusableReason: 'no_role' | null;
    accessToken: string | null;
}

/**
 * A usable Page is one the user may run: `MANAGE`, or `CREATE_CONTENT` and `MODERATE` together (publishing and replying to
 * comments are the two things this app does). A Page with no token in the list is one Meta did not give them access to.
 */
export function canRunPage(page: Pick<RawPage, 'tasks' | 'accessToken'>): boolean {
    if (!page.accessToken) return false;
    return page.tasks.includes('MANAGE') || (page.tasks.includes('CREATE_CONTENT') && page.tasks.includes('MODERATE'));
}

/** The picker's list. The token of a Page the user cannot run is dropped here, so it is never stored. */
export function classifyPages(pages: readonly RawPage[]): PageChoice[] {
    return pages.map((page) => {
        const usable = canRunPage(page);
        return {
            pageId: page.pageId, name: page.name, igId: page.igId, igUsername: page.igUsername,
            usable, unusableReason: usable ? null : 'no_role', accessToken: usable ? page.accessToken : null,
        };
    });
}

export type PagePlan =
    | { kind: 'none' }
    | { kind: 'auto'; choice: PageChoice }
    | { kind: 'pick' };

/**
 * What to do with the user's Pages: nothing to connect; connect the one Page that can be connected without asking; or ask. "Without
 * asking" is exactly one usable Page with an Instagram account: with two, the choice is theirs, and a Page with no Instagram account
 * is never connected without the person saying Facebook-only is what they want.
 */
export function planPages(choices: readonly PageChoice[]): PagePlan {
    if (choices.length === 0) return { kind: 'none' };
    const ready = choices.filter((c) => c.usable && c.igId);
    return ready.length === 1 ? { kind: 'auto', choice: ready[0]! } : { kind: 'pick' };
}

// ─── Checking a token, and who already has a Page (moved here from routes/admin.ts) ─────

/**
 * Validate a supplied Meta token before it is ever stored.
 *
 * Storing an unverified token means the first evidence that it is wrong is a customer's DM
 * silently failing. `debug_token` answers in one round-trip, and the two things it catches are
 * the two mistakes people actually make: pasting a USER token (which cannot post private
 * replies or publish at all) and pasting one that has already expired.
 *
 * Shared by the operator's paste-a-token routes (`routes/admin.ts`) and the Login flow: both end in a Page token that is stored,
 * and both owe it the same check.
 */
export async function validateSuppliedToken(
    token: string
): Promise<{ ok: true; inspection: TokenInspection } | { ok: false; error: string }> {
    let inspection: TokenInspection;
    try {
        inspection = await inspectToken(token);
    } catch (err: any) {
        const metaMessage = err?.response?.data?.error?.message;
        log('warn', 'admin.token_check_failed', describeError(err));
        return {
            ok: false,
            error: typeof metaMessage === 'string'
                ? `Meta could not verify that token: ${metaMessage}`
                : 'Meta could not be reached to verify that token — nothing was saved.',
        };
    }

    if (!inspection.isValid) {
        return { ok: false, error: inspection.error ?? 'Meta rejected that token.' };
    }
    if (inspection.type !== 'PAGE') {
        return {
            ok: false,
            error: `Wrong token type: "${inspection.type ?? 'unknown'}". You need a PAGE access token — `
                + 'a USER token cannot post private replies or publish.',
        };
    }
    return { ok: true, inspection };
}

/**
 * Refuse a page id already claimed by another creator.
 *
 * Checked explicitly rather than relying on the unique indexes, for a reason worth recording:
 * `instagram_page_id` has a real UNIQUE constraint from schema.sql, but
 * `idx_creators_facebook_page` was created as a PLAIN index by v3 and v10's
 * `CREATE UNIQUE INDEX IF NOT EXISTS` matched the name and silently did nothing — verified
 * against the live database. Migration v15 repairs it, but a route that only catches
 * `23505` would have been wrong on every deployment where it had not run yet. A pre-check is
 * also the only way to say *which* tenant holds the id, which is what the operator needs.
 */
export async function pageIdConflict(
    column: 'instagram_page_id' | 'facebook_page_id',
    value: string,
    excludingCreatorId: string
): Promise<{ id: string; name: string | null } | null> {
    const { rows } = await pool.query(
        `SELECT id, name FROM creators WHERE ${column} = $1 AND id <> $2 LIMIT 1`,
        [value, excludingCreatorId]
    );
    return rows[0] ?? null;
}

// ─── The tenant's current connection ────────────────────────────────────────────────────

export interface CurrentConnection {
    facebookPageId: string | null;
    instagramPageId: string | null;
    connected: boolean;
}

export async function readCurrent(creatorId: string): Promise<CurrentConnection | null> {
    const row = await queryOne<{ facebook_page_id: string | null; instagram_page_id: string | null; connected: boolean }>(
        `SELECT facebook_page_id, instagram_page_id, (page_access_token IS NOT NULL) AS connected FROM creators WHERE id = $1`,
        [creatorId]
    );
    return row ? { facebookPageId: row.facebook_page_id, instagramPageId: row.instagram_page_id, connected: row.connected } : null;
}

/**
 * Whether connecting `next` over `current` replaces a Page or an Instagram account the tenant already has: campaigns and posts are
 * tied to those ids, and the old ones stop matching. Gaining an id the tenant did not have (a legacy connection with no Facebook
 * Page id yet) is not a change; neither is the same ids again.
 */
export function replacesConnection(current: Pick<CurrentConnection, 'facebookPageId' | 'instagramPageId'>, next: { facebookPageId: string; instagramPageId: string | null }): boolean {
    return Boolean(current.facebookPageId && current.facebookPageId !== next.facebookPageId)
        || Boolean(current.instagramPageId && current.instagramPageId !== next.instagramPageId);
}

/** Refuse to touch a connection that is there, unless its owner asked for a reconnect. The first of the two checks, made before Meta is asked anything. */
export function assertMayConnect(current: CurrentConnection | null, opts: { reconnect: boolean }): CurrentConnection {
    if (!current) throw new MetaLoginError('tenant_not_found', 'This workspace does not exist.');
    if (current.connected && !opts.reconnect) {
        throw new MetaLoginError('already_connected', 'This workspace already has a Meta connection. Use Reconnect to replace it.');
    }
    return current;
}

export async function mayConnect(creatorId: string, opts: { reconnect: boolean }): Promise<CurrentConnection> {
    return assertMayConnect(await readCurrent(creatorId), opts);
}

/** Pages and Instagram accounts that belong to another tenant. The other tenant is never named: this is said to someone who must not learn who it is. */
export async function assertPageFree(creatorId: string, ids: { facebookPageId: string; instagramPageId: string | null }): Promise<void> {
    const clash = (await pageIdConflict('facebook_page_id', ids.facebookPageId, creatorId))
        ?? (ids.instagramPageId ? await pageIdConflict('instagram_page_id', ids.instagramPageId, creatorId) : null);
    if (clash) throw new MetaLoginError('page_in_use', 'That Page or Instagram account is already connected to another workspace.');
}

// ─── Webhook subscription ───────────────────────────────────────────────────────────────

export interface SubscriptionResult {
    /** The Page is subscribed to our app with every field, read back from Meta. */
    confirmed: boolean;
    warning: 'subscribe_failed' | 'subscribe_unconfirmed' | null;
}

/**
 * The Page fields a tenant's subscription needs on top of WEBHOOK_FIELDS: `['leadgen']` while the tenant has a recorded `lead_ads` legal sign-off
 * (A10), nothing otherwise. A Page that is not subscribed to `leadgen` is never sent a lead, which is exactly right for a tenant whose lead ads are
 * locked: no lead is fetched, no personal data arrives. The connect path asks this so a RECONNECT (a fresh `subscribed_apps` POST replaces the field
 * list, it does not add to it) never drops `leadgen` from a tenant that has it.
 *
 * It reads the sign-off table directly (`legalSignoff.ts` imports nothing of ours) instead of going through `ads/leads.ts`, which imports THIS module:
 * going the other way would be an import cycle. Fail-soft by design: any error (the table not there yet, the database busy) is `[]`, the usual four
 * fields, and the 6-hourly lead catch-up converges the subscription afterwards (`syncLeadgenSubscription`). A connection must never fail over this.
 */
export async function leadgenFieldsFor(creatorId: string): Promise<string[]> {
    try {
        return (await activeSignoff(creatorId, 'lead_ads')) ? ['leadgen'] : [];
    } catch (err) {
        log('warn', 'meta.leadgen_fields_unread', { creator_id: creatorId, ...describeError(err) });
        return [];
    }
}

/**
 * Subscribe the Page to the app's webhook (`POST /{page}/subscribed_apps`, the Page's own token), then read the edge back to
 * confirm it: a POST that answered success but left the Page without `messages` is a connection that never hears a DM. Never
 * throws: a failure is a warning on a connection that is still saved (the tenant can be re-subscribed; a connection thrown away
 * after the code was spent could not be).
 *
 * `extraFields` (A10: `leadgen`, only for a tenant with a lead_ads sign-off) are subscribed along with WEBHOOK_FIELDS, deduplicated, and every
 * one of them has to be on the read-back for the subscription to count as confirmed.
 */
export async function subscribePage(pageId: string, pageToken: string, appId: string | null, extraFields: readonly string[] = []): Promise<SubscriptionResult> {
    const secrets = [pageToken];
    const wanted = [...new Set([...WEBHOOK_FIELDS, ...extraFields])];
    try {
        await withRetry(
            () => metaHttp.post(
                `${GRAPH_BASE}/${pageId}/subscribed_apps`,
                new URLSearchParams({ subscribed_fields: wanted.join(',') }),
                { headers: { Authorization: `Bearer ${pageToken}` } }
            ),
            { label: 'meta.subscribe_page', retries: 2, baseMs: 400 }
        );
    } catch (err) {
        log('warn', 'meta.subscribe_failed', { page_id: pageId, ...describeError(graphError('graph_failed', 'meta.subscribe_page', err, secrets)) });
        return { confirmed: false, warning: 'subscribe_failed' };
    }

    try {
        const response = await withRetry(
            () => metaHttp.get(`${GRAPH_BASE}/${pageId}/subscribed_apps`, { headers: { Authorization: `Bearer ${pageToken}` } }),
            { label: 'meta.read_subscription', retries: 2, baseMs: 400 }
        );
        const apps: Array<{ id?: unknown; subscribed_fields?: unknown }> = Array.isArray(response.data?.data) ? response.data.data : [];
        const ours = apps.find((a) => (appId ? a?.id === appId : true));
        const fields = Array.isArray(ours?.subscribed_fields) ? ours.subscribed_fields : [];
        if (wanted.every((f) => fields.includes(f))) return { confirmed: true, warning: null };
        log('warn', 'meta.subscribe_incomplete', { page_id: pageId, have: fields.length, want: wanted.length });
        return { confirmed: false, warning: 'subscribe_unconfirmed' };
    } catch (err) {
        log('warn', 'meta.subscribe_unread', { page_id: pageId, ...describeError(graphError('graph_failed', 'meta.read_subscription', err, secrets)) });
        return { confirmed: false, warning: 'subscribe_unconfirmed' };
    }
}

/** Remove the app from the Page's subscribed apps (`DELETE /{page}/subscribed_apps`). Best effort: a Page whose token is already dead cannot be unsubscribed, and that must not trap a tenant with a connection it cannot remove. */
export async function unsubscribePage(pageId: string, pageToken: string): Promise<boolean> {
    try {
        await withRetry(
            () => metaHttp.delete(`${GRAPH_BASE}/${pageId}/subscribed_apps`, { headers: { Authorization: `Bearer ${pageToken}` } }),
            { label: 'meta.unsubscribe_page', retries: 2, baseMs: 400 }
        );
        return true;
    } catch (err) {
        log('warn', 'meta.unsubscribe_failed', { page_id: pageId, ...describeError(graphError('graph_failed', 'meta.unsubscribe_page', err, [pageToken])) });
        return false;
    }
}

// ─── Writing the connection ─────────────────────────────────────────────────────────────

export interface CompleteInput {
    creatorId: string;
    /** The dashboard user who connected, for the audit row. Null for a legacy shared-password session. */
    userId: string | null;
    /** The Facebook user who authorised. Stored in `meta_user_id`. */
    metaUserId: string;
    choice: { pageId: string; name: string; accessToken: string; igId: string | null; igUsername: string | null };
    /** Connect the Page without its Instagram account, because the person chose to. */
    facebookOnly?: boolean;
    /** The tenant's owner started this as a Reconnect. */
    reconnect: boolean;
    /** The owner confirmed that a reconnect to a different Page or Instagram account is what they want. */
    confirmPageChange?: boolean;
}

export type ConnectWarning = 'subscribe_failed' | 'subscribe_unconfirmed' | 'missing_scopes';

export interface CompleteResult {
    pageId: string;
    pageName: string;
    instagramId: string | null;
    instagramUsername: string | null;
    replaced: boolean;
    webhookSubscribed: boolean;
    warnings: ConnectWarning[];
    missingScopes: string[];
    affectedFeatures: string[];
}

/**
 * Write a Meta connection. The single place one is made from a Login, whether the user had one Page or chose among several.
 *
 *   1. Refuse an existing connection the owner did not ask to reconnect, and a reconnect to different ids that was not confirmed.
 *   2. Validate the Page token (`debug_token`; it must be type PAGE), the same check a pasted token gets.
 *   3. Refuse a Page or Instagram account another tenant holds, before Meta is asked to subscribe anything.
 *   4. Subscribe the Page to the webhook and read it back. A failure is a warning: the connection is still saved.
 *   5. ONE `UPDATE`: the ids, the encrypted token, the `token_*` columns, the Facebook user, the Page's name, the Instagram
 *      username and the times. A concurrent connection that won the race fails the `WHERE` rather than being overwritten.
 *   6. Drop the tenant cache and write the audit row. The user token is never stored: it is not even an argument.
 */
export async function completeMetaConnection(input: CompleteInput): Promise<CompleteResult> {
    const { creatorId, choice } = input;
    const secrets = [choice.accessToken];
    const ids = { facebookPageId: choice.pageId, instagramPageId: input.facebookOnly ? null : choice.igId };

    const current = assertMayConnect(await readCurrent(creatorId), { reconnect: input.reconnect });
    const replaced = current.connected && replacesConnection(current, ids);
    if (replaced && !input.confirmPageChange) {
        throw new MetaLoginError('page_change_unconfirmed', 'This would replace the connected Page or Instagram account with a different one. Confirm to continue.');
    }

    const checked = await validateSuppliedToken(choice.accessToken);
    if (!checked.ok) throw new MetaLoginError('token_invalid', checked.error, { secrets });
    const inspection = checked.inspection;

    await assertPageFree(creatorId, ids);

    let encrypted: string;
    try {
        encrypted = encryptSecret(choice.accessToken);
    } catch {
        throw new MetaLoginError('encryption_unavailable', 'TOKEN_ENCRYPTION_KEY is not configured: a Page token cannot be stored.');
    }

    const subscription = await subscribePage(choice.pageId, choice.accessToken, readMetaApp()?.appId ?? null, await leadgenFieldsFor(creatorId));

    let saved: { id: string } | null;
    try {
        saved = await queryOne<{ id: string }>(
            `UPDATE creators
                SET instagram_page_id = $2, facebook_page_id = $3, page_access_token = $4,
                    token_status = $5, token_error = $6, token_last_checked_at = NOW(),
                    token_expires_at = $7, token_data_access_expires_at = $8,
                    meta_user_id = $9, meta_page_name = $10,
                    instagram_username = CASE WHEN $11::text IS NOT NULL THEN $11::text ELSE instagram_username END,
                    meta_connected_at = NOW(), meta_webhook_subscribed_at = $12
              WHERE id = $1 AND ($13::boolean OR page_access_token IS NULL)
          RETURNING id`,
            [
                creatorId, ids.instagramPageId, ids.facebookPageId, encrypted,
                inspectionStatus(inspection), inspection.error,
                inspection.expiresAt, inspection.dataAccessExpiresAt,
                input.metaUserId, choice.name,
                ids.instagramPageId ? choice.igUsername : null,
                subscription.confirmed ? new Date() : null,
                input.reconnect,
            ]
        );
    } catch (err: any) {
        // The unique indexes on instagram_page_id and facebook_page_id: another tenant claimed the id between the check and here.
        if (err?.code === '23505') throw new MetaLoginError('page_in_use', 'That Page or Instagram account is already connected to another workspace.');
        throw err;
    }
    if (!saved) {
        // Not found (deleted meanwhile), or connected by someone else between the first check and the write.
        throw assertMayConnectError(await readCurrent(creatorId));
    }

    invalidateTenantCache();

    const warnings: ConnectWarning[] = [];
    if (subscription.warning) warnings.push(subscription.warning);
    if (inspection.missingScopes.length) warnings.push('missing_scopes');

    const result: CompleteResult = {
        pageId: ids.facebookPageId,
        pageName: choice.name,
        instagramId: ids.instagramPageId,
        instagramUsername: ids.instagramPageId ? choice.igUsername : null,
        replaced,
        webhookSubscribed: subscription.confirmed,
        warnings,
        missingScopes: inspection.missingScopes,
        affectedFeatures: affectedFeatures(inspection.missingScopes),
    };

    await writeAudit(await actorFromSession({ userId: input.userId }), {
        action: AUDIT_ACTIONS.metaConnect,
        targetType: 'creator',
        targetId: creatorId,
        // Ids and facts only: the audit log is never cleared, and a token here would be persisted AND served by the admin route.
        detail: {
            facebook_page_id: result.pageId,
            instagram_page_id: result.instagramId,
            reconnect: input.reconnect,
            replaced_connection: replaced,
            webhook_subscribed: result.webhookSubscribed,
            warnings,
            missing_scopes: result.missingScopes,
            credential_type: inspection.type,
        },
    });
    log('info', 'meta.connected', {
        creator_id: creatorId, page_id: result.pageId, instagram_connected: Boolean(result.instagramId),
        webhook_subscribed: result.webhookSubscribed, replaced, warnings,
    });
    return result;
}

/** The refusal for a write that matched no row: the tenant is gone, or somebody connected it first. */
function assertMayConnectError(current: CurrentConnection | null): MetaLoginError {
    return current
        ? new MetaLoginError('already_connected', 'This workspace was connected by someone else a moment ago. Nothing was changed.')
        : new MetaLoginError('tenant_not_found', 'This workspace does not exist.');
}

// ─── The callback ───────────────────────────────────────────────────────────────────────

/** What `meta_pick` holds, encrypted: the user and the Pages to choose among. Tokens only for Pages the user can run. */
export interface PickPayload {
    v: 1;
    metaUserId: string;
    metaUserName: string | null;
    reconnect: boolean;
    choices: Array<{
        pageId: string; name: string; igId: string | null; igUsername: string | null;
        usable: boolean; unusableReason: 'no_role' | null; accessToken: string | null;
    }>;
}

/** What `meta` holds, encrypted: what the connect asked for. */
export interface ConnectIntent { v: 1; reconnect: boolean }

/** The intent from a consumed `meta` state. A payload that is missing or unreadable is "no reconnect", which refuses to overwrite. */
export function readIntent(payload: unknown): ConnectIntent {
    return { v: 1, reconnect: (payload as { reconnect?: unknown } | null)?.reconnect === true };
}

/** A pick payload as it came out of the database, or null when it is not one of ours. */
export function readPickPayload(payload: unknown): PickPayload | null {
    const p = payload as Partial<PickPayload> | null;
    if (!p || p.v !== 1 || typeof p.metaUserId !== 'string' || !Array.isArray(p.choices)) return null;
    return p as PickPayload;
}

export type LoginOutcome =
    | { kind: 'connected'; result: CompleteResult }
    | { kind: 'pick'; pick: string };

export interface FinishLoginInput {
    creatorId: string;
    userId: string | null;
    code: string;
    redirectUri: string;
    /** From the consumed state's payload: the owner started this as a Reconnect. */
    reconnect: boolean;
    returnTo: OAuthReturnTo | null;
}

/**
 * The callback's work after its state was spent: code → user token → long-lived user token → identity, permissions and Pages →
 * connect the one obvious Page, or store the choices for the picker. Throws `MetaLoginError` for everything the callback turns
 * into a reason code; the user token exists only inside this function.
 */
export async function finishLogin(input: FinishLoginInput): Promise<LoginOutcome> {
    const app = readMetaApp();
    if (!app) throw new MetaLoginError('not_configured', 'META_APP_ID and META_APP_SECRET must both be set.');

    // Before Meta is asked anything: a tenant that is connected, whose owner did not say Reconnect, is left exactly as it is.
    const current = await mayConnect(input.creatorId, { reconnect: input.reconnect });

    const shortToken = await exchangeCode(app, input.code, input.redirectUri);
    const userToken = await extendUserToken(app, shortToken);
    const [identity, permissions, pages] = await Promise.all([
        readIdentity(userToken), readPermissions(userToken), listPages(userToken),
    ]);

    // The user token has done its work. Nothing below can store it, and it is not passed on.
    if (permissions.granted.length === 0) {
        throw new MetaLoginError('not_tester', 'Nothing was granted: this Facebook account may not hold a role on the app.', { secrets: [userToken] });
    }
    const missingCore = CORE_SCOPES.filter((s) => !permissions.granted.includes(s));
    if (missingCore.length) {
        throw new MetaLoginError('permissions_missing', `Required permissions were declined: ${missingCore.join(', ')}.`, { secrets: [userToken] });
    }

    // Boost: when the person granted the ads permissions, their token becomes the tenant's ads token and a sole ad account is picked.
    // The one deliberate exception to "the user token is never stored", and only for ads. Fail-soft: it never stops the connection.
    await captureAdsAccess(input.creatorId, userToken, permissions.granted, input.userId).catch((err) => {
        log('warn', 'meta.ads_capture_failed', { creator_id: input.creatorId, reason: scrubSecrets(err instanceof Error ? err.message : String(err), [userToken]) });
    });

    const choices = classifyPages(pages);
    const plan = planPages(choices);
    if (plan.kind === 'none') throw new MetaLoginError('no_pages', 'This Facebook account manages no Page.');

    // One obvious Page connects at once, unless that would replace a different Page on a reconnect: that is asked.
    if (plan.kind === 'auto' && !(current.connected && replacesConnection(current, { facebookPageId: plan.choice.pageId, instagramPageId: plan.choice.igId }))) {
        const result = await completeMetaConnection({
            creatorId: input.creatorId, userId: input.userId, metaUserId: identity.id,
            choice: {
                pageId: plan.choice.pageId, name: plan.choice.name, accessToken: plan.choice.accessToken!,
                igId: plan.choice.igId, igUsername: plan.choice.igUsername,
            },
            reconnect: input.reconnect, confirmPageChange: false,
        });
        return { kind: 'connected', result };
    }

    const payload: PickPayload = {
        v: 1, metaUserId: identity.id, metaUserName: identity.name, reconnect: input.reconnect,
        choices: choices.map((c) => ({ ...c })),
    };
    const pick = await createOAuthState({
        purpose: 'meta_pick', creatorId: input.creatorId, userId: input.userId, returnTo: input.returnTo, payload,
    });
    log('info', 'meta.pick_created', { creator_id: input.creatorId, pages: choices.length, usable: choices.filter((c) => c.usable).length });
    return { kind: 'pick', pick };
}

/** What the picker may see of a pick: names and ids, and why a Page is disabled. Never a token. */
export function publicChoices(payload: PickPayload): Array<{ pageId: string; name: string; instagram: { id: string; username: string | null } | null; usable: boolean; reason: 'no_role' | null }> {
    return payload.choices.map((c) => ({
        pageId: c.pageId,
        name: c.name,
        instagram: c.igId ? { id: c.igId, username: c.igUsername } : null,
        usable: c.usable,
        reason: c.unusableReason,
    }));
}

// ─── Reading and removing the connection ────────────────────────────────────────────────

export interface MetaConnectionSummary {
    connected: boolean;
    /** `login` when made with Facebook Login, `token` when an operator pasted a token. */
    via: 'login' | 'token' | null;
    pageId: string | null;
    pageName: string | null;
    instagramId: string | null;
    instagramUsername: string | null;
    connectedAt: string | null;
    webhookSubscribed: boolean;
    webhookSubscribedAt: string | null;
    tokenStatus: string | null;
    tokenError: string | null;
    tokenLastCheckedAt: string | null;
    tokenExpiresAt: string | null;
    dataAccessExpiresAt: string | null;
    /**
     * The connection needs its owner to reconnect: Meta said the token is dead (`invalid`), or Instagram's data access (or the token
     * itself) lapses within `RECONNECT_DUE_DAYS` or already has (`expiring`; the Reconnect button then offers `reauthorize`). Read from
     * what is STORED: only a definitive result, from the daily recheck (`metaTokenRecheck.ts`), a send that met a code 190, or a
     * person pressing Re-check, ever writes either, so a Meta outage does not raise it.
     */
    reconnectDue: boolean;
    reconnectReason: 'invalid' | 'expiring' | null;
}

/** Is this date, if there is one, less than `RECONNECT_DUE_DAYS` away (or past)? */
function isNear(at: Date | string | null, now: number = Date.now()): boolean {
    if (!at) return false;
    const time = new Date(at).getTime();
    return !Number.isNaN(time) && time - now < RECONNECT_DUE_DAYS * 86_400_000;
}

/** What the dashboard may see. The token is never selected: only whether one exists. */
export async function getMetaConnection(creatorId: string): Promise<MetaConnectionSummary | null> {
    const row = await queryOne<{
        instagram_page_id: string | null; facebook_page_id: string | null; has_token: boolean;
        meta_page_name: string | null; instagram_username: string | null;
        meta_connected_at: Date | null; meta_webhook_subscribed_at: Date | null;
        token_status: string | null; token_error: string | null; token_last_checked_at: Date | null;
        token_expires_at: Date | null; token_data_access_expires_at: Date | null;
    }>(
        `SELECT instagram_page_id, facebook_page_id, (page_access_token IS NOT NULL) AS has_token,
                meta_page_name, instagram_username, meta_connected_at, meta_webhook_subscribed_at,
                token_status, token_error, token_last_checked_at, token_expires_at, token_data_access_expires_at
           FROM creators WHERE id = $1`,
        [creatorId]
    );
    if (!row) return null;
    const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
    const connected = row.has_token;
    const invalid = connected && row.token_status === 'invalid';
    const expiring = connected && (isNear(row.token_data_access_expires_at) || isNear(row.token_expires_at));
    return {
        connected,
        via: connected ? (row.meta_connected_at ? 'login' : 'token') : null,
        pageId: row.facebook_page_id,
        pageName: row.meta_page_name,
        instagramId: row.instagram_page_id,
        instagramUsername: connected ? row.instagram_username : null,
        connectedAt: iso(row.meta_connected_at),
        webhookSubscribed: Boolean(row.meta_webhook_subscribed_at),
        webhookSubscribedAt: iso(row.meta_webhook_subscribed_at),
        tokenStatus: connected ? row.token_status : null,
        tokenError: connected ? row.token_error : null,
        tokenLastCheckedAt: iso(row.token_last_checked_at),
        tokenExpiresAt: iso(row.token_expires_at),
        dataAccessExpiresAt: iso(row.token_data_access_expires_at),
        reconnectDue: invalid || expiring,
        reconnectReason: invalid ? 'invalid' : expiring ? 'expiring' : null,
    };
}

/**
 * The removal itself, shared by a person pressing Disconnect (`disconnectMeta`) and Meta telling us a person removed the app
 * (`metaDeauth.ts`): unsubscribe the Page from the webhook (best effort), then clear the ids, the token and the `meta_*` columns in one
 * UPDATE. Writes no audit row: each caller says WHO did it.
 *
 * `onlyIfMetaUser` is the guard the deauthorize callback needs and a Disconnect does not: the UPDATE then matches only while the tenant's
 * `meta_user_id` is still that person, so a tenant that was reconnected by somebody else between finding it and clearing it is left exactly
 * as it is (`cleared: false`). Null (a Disconnect) means "this tenant, whoever connected it".
 */
export async function removeMetaConnection(
    creatorId: string,
    current: Pick<CurrentConnection, 'facebookPageId' | 'connected'>,
    onlyIfMetaUser: string | null = null,
): Promise<{ cleared: boolean; unsubscribed: boolean }> {
    let unsubscribed = false;
    if (current.connected && current.facebookPageId) {
        // A token that cannot be read is a connection that can still be removed: it just cannot be unsubscribed first.
        let token = '';
        try {
            token = (await getTenant(creatorId, ['id', 'page_access_token']))?.page_access_token ?? '';
        } catch (err) {
            log('warn', 'meta.disconnect_token_unreadable', { creator_id: creatorId, ...describeError(err) });
        }
        if (token) unsubscribed = await unsubscribePage(current.facebookPageId, token);
    }

    const cleared = await queryCount(
        `UPDATE creators
            SET instagram_page_id = NULL, facebook_page_id = NULL, page_access_token = NULL,
                token_status = 'unknown', token_error = NULL, token_last_checked_at = NULL,
                token_expires_at = NULL, token_data_access_expires_at = NULL,
                meta_user_id = NULL, meta_page_name = NULL, meta_connected_at = NULL, meta_webhook_subscribed_at = NULL
          WHERE id = $1 AND ($2::text IS NULL OR meta_user_id = $2)`,
        [creatorId, onlyIfMetaUser]
    );
    invalidateTenantCache();
    // The ads token that came with that Connect goes with it (a pasted one stays: the owner put it there by hand).
    if (cleared > 0) {
        await forgetConnectedAdsAccess(creatorId).catch((err) => log('warn', 'meta.ads_forget_failed', { creator_id: creatorId, ...describeError(err) }));
    }
    return { cleared: cleared > 0, unsubscribed };
}

/**
 * Remove a tenant's Meta connection: unsubscribe the Page from the webhook (best effort), then clear the ids, the token and the
 * `meta_*` columns in one UPDATE. Campaigns, posts and everything else the tenant made are kept. The Facebook user's permissions
 * are NOT revoked (`DELETE /{user}/permissions`): that would cut off every other tenant the same person connected.
 */
export async function disconnectMeta(input: { creatorId: string; userId: string | null }): Promise<{ unsubscribed: boolean }> {
    const row = await readCurrent(input.creatorId);
    if (!row) throw new MetaLoginError('tenant_not_found', 'This workspace does not exist.');
    if (!row.connected && !row.facebookPageId && !row.instagramPageId) {
        throw new MetaLoginError('not_connected', 'Meta is not connected for this workspace.');
    }

    const { unsubscribed } = await removeMetaConnection(input.creatorId, row);

    await writeAudit(await actorFromSession({ userId: input.userId }), {
        action: AUDIT_ACTIONS.metaDisconnect,
        targetType: 'creator',
        targetId: input.creatorId,
        detail: {
            facebook_page_id: row.facebookPageId,
            instagram_page_id: row.instagramPageId,
            unsubscribed_from_webhook: unsubscribed,
        },
    });
    log('info', 'meta.disconnected', { creator_id: input.creatorId, unsubscribed });
    return { unsubscribed };
}
