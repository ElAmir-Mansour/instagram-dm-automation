/**
 * TikTok connections: the OAuth state, the stored tokens, and keeping them alive.
 *
 * The only module that reads or writes `platform_connections` and `oauth_states`, for the same
 * reason `tenant.ts` is the only reader of `creators.page_access_token`: decryption happens in
 * one place, so no path can send `enc:v1:...` to TikTok as a bearer token.
 *
 * ── Token lifetimes ──
 * TikTok access tokens last 24 hours. Refresh tokens are valid for 365 days *from the first
 * authorisation* — refreshing does not extend that — and may rotate on every refresh ("You
 * must use the newly-returned token"). So an access token is refreshed on use when it is
 * close to expiry, the daily cron refreshes every connection as a health check the Meta side
 * has never had, and the dashboard warns ahead of the yearly hard expiry, when the creator has
 * to reconnect. TikTok does not document whether a rotated-out refresh token keeps working
 * for a grace period, so only one refresh may run at a time (`refresh_claimed_at`).
 */
import crypto from 'crypto';
import { encryptSecret, decryptSecret } from '../config/crypto.js';
import { queryCount, queryOne, queryRows } from '../db/query.js';
import type { PlatformConnectionRow } from '../db/rows.js';
import { describeError, log } from '../utils/log.js';
import { getTikTokAppConfig } from './appSettings.js';
import {
    exchangeCode, getUserInfo, isTikTokReauthError, refreshTokens, revokeToken,
    TikTokApiError, type TikTokTokenSet,
} from './tiktok.js';

/** Refresh an access token this close to expiry rather than risk it dying mid-upload. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
/** A refresh claim older than this belongs to an invocation that died. */
const REFRESH_CLAIM_STALE_MS = 2 * 60 * 1000;
/** How long an OAuth round trip may take. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Raised when there is no usable connection: never connected, revoked, or refused on refresh. */
export class TikTokNotConnectedError extends Error {
    constructor(message = 'TikTok is not connected for this account — connect it in Settings.') {
        super(message);
        this.name = 'TikTokNotConnectedError';
    }
}

// ─── OAuth state ────────────────────────────────────────────────────────────────────────

/**
 * Mint a single-use state for one tenant + user. Also sweeps states that expired over a day
 * ago, so the table never needs a job of its own.
 */
export async function createOAuthState(creatorId: string, userId: string | null): Promise<string> {
    const nonce = crypto.randomBytes(32).toString('base64url');
    await queryCount(`DELETE FROM oauth_states WHERE expires_at < NOW() - INTERVAL '1 day'`);
    await queryCount(
        `INSERT INTO oauth_states (nonce, platform, creator_id, user_id, expires_at)
         VALUES ($1, 'tiktok', $2, $3, $4)`,
        [nonce, creatorId, userId, new Date(Date.now() + OAUTH_STATE_TTL_MS)]
    );
    return nonce;
}

/**
 * Consume a state: succeeds at most once, and only before it expires. The UPDATE is the check —
 * two concurrent callbacks carrying the same state cannot both match `used_at IS NULL`.
 */
export async function consumeOAuthState(
    nonce: string
): Promise<{ creatorId: string; userId: string | null } | null> {
    const row = await queryOne<{ creator_id: string; user_id: string | null }>(
        `UPDATE oauth_states
            SET used_at = NOW()
          WHERE nonce = $1 AND platform = 'tiktok' AND used_at IS NULL AND expires_at > NOW()
      RETURNING creator_id, user_id`,
        [nonce]
    );
    return row ? { creatorId: row.creator_id, userId: row.user_id } : null;
}

// ─── Reading ────────────────────────────────────────────────────────────────────────────

export async function getConnection(creatorId: string): Promise<PlatformConnectionRow | null> {
    return queryOne<PlatformConnectionRow>(
        `SELECT * FROM platform_connections WHERE creator_id = $1 AND platform = 'tiktok'`,
        [creatorId]
    );
}

/** What the dashboard may see. Never a token — only whether one exists and when it expires. */
export interface ConnectionSummary {
    connected: boolean;
    status: PlatformConnectionRow['status'] | null;
    displayName: string | null;
    avatarUrl: string | null;
    scopes: string[];
    canUpload: boolean;
    accessExpiresAt: string | null;
    refreshExpiresAt: string | null;
    lastRefreshedAt: string | null;
    lastError: string | null;
    connectedAt: string | null;
}

export function summariseConnection(row: PlatformConnectionRow | null): ConnectionSummary {
    const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
    if (!row) {
        return {
            connected: false, status: null, displayName: null, avatarUrl: null, scopes: [],
            canUpload: false, accessExpiresAt: null, refreshExpiresAt: null, lastRefreshedAt: null,
            lastError: null, connectedAt: null,
        };
    }
    return {
        connected: row.status === 'active' && Boolean(row.refresh_token),
        status: row.status,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        scopes: row.scopes ?? [],
        canUpload: (row.scopes ?? []).includes('video.upload'),
        accessExpiresAt: iso(row.access_expires_at),
        refreshExpiresAt: iso(row.refresh_expires_at),
        lastRefreshedAt: iso(row.last_refreshed_at),
        lastError: row.last_error,
        connectedAt: iso(row.created_at),
    };
}

// ─── Connecting ─────────────────────────────────────────────────────────────────────────

/** Raised when the TikTok account is already attached to a different tenant. */
export class TikTokAccountInUseError extends Error {
    constructor() {
        super('This TikTok account is already connected to another workspace. Disconnect it there first.');
        this.name = 'TikTokAccountInUseError';
    }
}

/**
 * Finish an OAuth round trip: exchange the code, read who the account is, store it all.
 * Reconnecting replaces the tenant's existing connection in place.
 */
export async function completeConnection(input: {
    creatorId: string;
    userId: string | null;
    code: string;
    redirectUri: string;
}): Promise<PlatformConnectionRow> {
    const app = await getTikTokAppConfig();
    if (!app) throw new Error('TikTok app credentials are not configured.');

    const tokens = await exchangeCode({
        clientKey: app.clientKey, clientSecret: app.clientSecret,
        code: input.code, redirectUri: input.redirectUri,
    });

    // The profile is decoration — a name and avatar for the Settings card. A failure here must
    // not throw away a token exchange that already succeeded (the code is spent).
    let displayName: string | null = null;
    let avatarUrl: string | null = null;
    try {
        const profile = await getUserInfo(tokens.accessToken);
        displayName = profile.displayName;
        avatarUrl = profile.avatarUrl;
    } catch (err) {
        log('warn', 'tiktok.user_info_failed', describeError(err));
    }

    try {
        const row = await queryOne<PlatformConnectionRow>(
            `INSERT INTO platform_connections (
                 creator_id, platform, external_account_id, display_name, avatar_url, scopes,
                 access_token, access_expires_at, refresh_token, refresh_expires_at,
                 status, last_error, last_refreshed_at, refresh_claimed_at, connected_by_user_id
             ) VALUES ($1, 'tiktok', $2, $3, $4, $5, $6, $7, $8, $9, 'active', NULL, NOW(), NULL, $10)
             ON CONFLICT (creator_id, platform) DO UPDATE SET
                 external_account_id = EXCLUDED.external_account_id,
                 display_name = EXCLUDED.display_name,
                 avatar_url = EXCLUDED.avatar_url,
                 scopes = EXCLUDED.scopes,
                 access_token = EXCLUDED.access_token,
                 access_expires_at = EXCLUDED.access_expires_at,
                 refresh_token = EXCLUDED.refresh_token,
                 refresh_expires_at = EXCLUDED.refresh_expires_at,
                 status = 'active', last_error = NULL, last_refreshed_at = NOW(),
                 refresh_claimed_at = NULL,
                 connected_by_user_id = EXCLUDED.connected_by_user_id,
                 updated_at = NOW()
             RETURNING *`,
            [
                input.creatorId, tokens.openId, displayName, avatarUrl, tokens.scopes,
                encryptSecret(tokens.accessToken), tokens.accessExpiresAt,
                encryptSecret(tokens.refreshToken), tokens.refreshExpiresAt,
                input.userId,
            ]
        );
        if (!row) throw new Error('Saving the TikTok connection returned no row.');
        return row;
    } catch (err: any) {
        // uq_platform_connections_account: the same open_id on another tenant. Webhooks name the
        // account by open_id, so one account cannot belong to two tenants.
        if (err?.code === '23505') throw new TikTokAccountInUseError();
        throw err;
    }
}

// ─── Using ──────────────────────────────────────────────────────────────────────────────

function isFresh(row: Pick<PlatformConnectionRow, 'access_token' | 'access_expires_at'>, now: number): boolean {
    return Boolean(row.access_token)
        && row.access_expires_at !== null
        && new Date(row.access_expires_at).getTime() - now > REFRESH_MARGIN_MS;
}

async function writeRefreshed(connectionId: string, tokens: TikTokTokenSet): Promise<PlatformConnectionRow> {
    const row = await queryOne<PlatformConnectionRow>(
        `UPDATE platform_connections
            SET access_token = $2, access_expires_at = $3,
                refresh_token = $4, refresh_expires_at = $5,
                scopes = CASE WHEN cardinality($6::text[]) > 0 THEN $6::text[] ELSE scopes END,
                status = 'active', last_error = NULL, last_refreshed_at = NOW(),
                refresh_claimed_at = NULL, updated_at = NOW()
          WHERE id = $1
      RETURNING *`,
        [
            connectionId, encryptSecret(tokens.accessToken), tokens.accessExpiresAt,
            encryptSecret(tokens.refreshToken), tokens.refreshExpiresAt, tokens.scopes,
        ]
    );
    if (!row) throw new TikTokNotConnectedError('The TikTok connection was removed during a refresh.');
    return row;
}

/** Record that TikTok refused this connection, so every surface shows "reconnect". */
export async function markConnectionInvalid(connectionId: string, reason: string): Promise<void> {
    await queryCount(
        `UPDATE platform_connections
            SET status = 'invalid', last_error = $2, refresh_claimed_at = NULL, updated_at = NOW()
          WHERE id = $1`,
        [connectionId, reason.slice(0, 500)]
    );
}

/**
 * Refresh one connection under a claim. Returns the updated row, or null when another
 * invocation holds the claim.
 */
async function refreshUnderClaim(connectionId: string): Promise<PlatformConnectionRow | null> {
    const claimed = await queryOne<PlatformConnectionRow>(
        `UPDATE platform_connections
            SET refresh_claimed_at = NOW()
          WHERE id = $1 AND status = 'active' AND refresh_token IS NOT NULL
            AND (refresh_claimed_at IS NULL OR refresh_claimed_at < $2)
      RETURNING *`,
        [connectionId, new Date(Date.now() - REFRESH_CLAIM_STALE_MS)]
    );
    if (!claimed) return null;

    const app = await getTikTokAppConfig();
    if (!app) {
        await queryCount('UPDATE platform_connections SET refresh_claimed_at = NULL WHERE id = $1', [connectionId]);
        throw new Error('TikTok app credentials are not configured.');
    }

    try {
        const tokens = await refreshTokens({
            clientKey: app.clientKey, clientSecret: app.clientSecret,
            refreshToken: decryptSecret(claimed.refresh_token),
        });
        const row = await writeRefreshed(connectionId, tokens);
        log('info', 'tiktok.token_refreshed', { connection_id: connectionId, creator_id: claimed.creator_id });
        return row;
    } catch (err) {
        if (isTikTokReauthError(err)) {
            // Before declaring the connection dead, check nobody else rotated the token under
            // us — a stale claim reaped by a second invocation is the one way that can happen.
            const current = await queryOne<Pick<PlatformConnectionRow, 'refresh_token'>>(
                'SELECT refresh_token FROM platform_connections WHERE id = $1',
                [connectionId]
            );
            if (current && current.refresh_token !== claimed.refresh_token) {
                await queryCount('UPDATE platform_connections SET refresh_claimed_at = NULL WHERE id = $1', [connectionId]);
                return getConnection(claimed.creator_id);
            }
            await markConnectionInvalid(connectionId, (err as Error).message);
            log('warn', 'tiktok.token_refresh_refused', { connection_id: connectionId, ...describeError(err) });
            throw new TikTokNotConnectedError((err as Error).message);
        }
        // Transient: release the claim so the next caller can try again.
        await queryCount('UPDATE platform_connections SET refresh_claimed_at = NULL WHERE id = $1', [connectionId]);
        throw err;
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A working access token for this tenant, refreshing it if it is close to expiry.
 *
 * When another invocation is mid-refresh, waits briefly for it rather than refreshing in
 * parallel — a second refresh could present a refresh token the first one just rotated away.
 */
export async function getAccessToken(
    creatorId: string
): Promise<{ accessToken: string; connection: PlatformConnectionRow }> {
    let row = await getConnection(creatorId);
    if (!row || row.status === 'revoked' || !row.refresh_token) throw new TikTokNotConnectedError();
    if (row.status === 'invalid') {
        throw new TikTokNotConnectedError(row.last_error ?? 'The TikTok connection needs to be reconnected in Settings.');
    }

    for (let attempt = 0; attempt < 4; attempt++) {
        if (isFresh(row, Date.now())) {
            return { accessToken: decryptSecret(row.access_token), connection: row };
        }
        const refreshed = await refreshUnderClaim(row.id);
        if (refreshed) return { accessToken: decryptSecret(refreshed.access_token), connection: refreshed };

        await sleep(1500);
        row = await getConnection(creatorId);
        if (!row || row.status !== 'active') throw new TikTokNotConnectedError();
    }
    throw new Error('The TikTok token is being refreshed by another request — retry in a moment.');
}

/**
 * The daily check: refresh every active connection, so a revoked or broken one is found by the
 * cron rather than by the next scheduled post. Cannot throw — one tenant's failure is recorded
 * on its row and does not stop the rest, or the cron that called this.
 */
export async function refreshAllConnections(): Promise<{ refreshed: number; failed: number }> {
    let refreshed = 0;
    let failed = 0;
    let rows: Pick<PlatformConnectionRow, 'id' | 'creator_id'>[] = [];
    try {
        rows = await queryRows<Pick<PlatformConnectionRow, 'id' | 'creator_id'>>(
            `SELECT id, creator_id FROM platform_connections
              WHERE platform = 'tiktok' AND status = 'active' AND refresh_token IS NOT NULL
              ORDER BY last_refreshed_at NULLS FIRST
              LIMIT 50`
        );
    } catch (err) {
        log('error', 'tiktok.refresh_sweep_failed', describeError(err));
        return { refreshed, failed };
    }
    for (const row of rows) {
        try {
            if (await refreshUnderClaim(row.id)) refreshed++;
        } catch (err) {
            failed++;
            log('warn', 'tiktok.refresh_sweep_row_failed', { connection_id: row.id, ...describeError(err) });
        }
    }
    return { refreshed, failed };
}

/**
 * Note a failed API call. Only a re-auth error changes anything: the connection is marked
 * invalid so the dashboard asks for a reconnect instead of the next post failing the same way.
 */
export async function noteTikTokFailure(connectionId: string | null, err: unknown): Promise<void> {
    if (!connectionId || !isTikTokReauthError(err)) return;
    try {
        await markConnectionInvalid(connectionId, (err as TikTokApiError).message);
    } catch (writeErr) {
        log('error', 'tiktok.note_failure_failed', describeError(writeErr));
    }
}

// ─── Disconnecting ──────────────────────────────────────────────────────────────────────

/**
 * Revoke with TikTok, then delete the row. The revoke is best-effort: a connection TikTok
 * already considers dead cannot be revoked, and that must not trap the user with a
 * connection they cannot remove. The local delete is what the data-deletion page promises.
 */
export async function disconnect(creatorId: string): Promise<{ removed: boolean; revoked: boolean }> {
    const row = await getConnection(creatorId);
    if (!row) return { removed: false, revoked: false };

    let revoked = false;
    const app = await getTikTokAppConfig();
    const token = row.access_token ? decryptSecret(row.access_token) : '';
    if (app && token) {
        try {
            await revokeToken({ clientKey: app.clientKey, clientSecret: app.clientSecret, token });
            revoked = true;
        } catch (err) {
            log('warn', 'tiktok.revoke_failed', { connection_id: row.id, ...describeError(err) });
        }
    }
    await queryCount('DELETE FROM platform_connections WHERE id = $1', [row.id]);
    return { removed: true, revoked };
}

/**
 * TikTok's `authorization.removed` webhook: the user removed the app from their TikTok account.
 * The tokens are already dead on TikTok's side. The row is deleted outright — not kept as a
 * `revoked` tombstone — because /data-deletion promises that this route removes the same data
 * a Settings disconnect does: the open_id, display name, avatar and both tokens.
 */
export async function deleteConnectionByOpenId(openId: string): Promise<number> {
    return queryCount(
        `DELETE FROM platform_connections WHERE platform = 'tiktok' AND external_account_id = $1`,
        [openId]
    );
}

/** Used by the webhook to confirm an event names an account we know. */
export async function connectionByOpenId(openId: string): Promise<Pick<PlatformConnectionRow, 'id' | 'creator_id'> | null> {
    return queryOne<Pick<PlatformConnectionRow, 'id' | 'creator_id'>>(
        `SELECT id, creator_id FROM platform_connections WHERE platform = 'tiktok' AND external_account_id = $1`,
        [openId]
    );
}

// Exported for tests.
export const _internals = { isFresh, REFRESH_MARGIN_MS };
