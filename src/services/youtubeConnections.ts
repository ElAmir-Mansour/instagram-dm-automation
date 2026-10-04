/**
 * YouTube connections: the OAuth state, the stored tokens, and keeping them alive.
 *
 * The only module that reads or writes `platform_connections` rows with `platform = 'youtube'`, as
 * tiktokConnections.ts is for TikTok's: tokens are decrypted in one place.
 *
 * Simpler than TikTok's, because Google does not rotate a refresh token when it is used: two
 * refreshes at once both get a working access token, so there is no claim to hold. A refresh that
 * Google refuses (`invalid_grant`: access removed, or a Testing app's 7 days are up) marks the
 * connection invalid, and Settings asks for a reconnect.
 *
 * The daily cron refreshes every connection and re-reads its channel, which also keeps the name and
 * picture we store no older than a day, as YouTube's developer policies ask of stored API data.
 */
import crypto from 'crypto';
import { encryptSecret, decryptSecret } from '../config/crypto.js';
import { queryCount, queryOne, queryRows } from '../db/query.js';
import type { PlatformConnectionRow } from '../db/rows.js';
import { describeError, log } from '../utils/log.js';
import { getYouTubeAppConfig } from './appSettings.js';
import {
    exchangeCode, getMyChannel, isYouTubeReauthError, refreshAccessToken, revokeToken,
    SCOPE_READONLY, SCOPE_UPLOAD, type GoogleTokenSet,
} from './youtube.js';

/** Refresh an access token this close to its hour being up. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export class YouTubeNotConnectedError extends Error {
    constructor(message = 'YouTube is not connected for this account — connect it in Settings.') {
        super(message);
        this.name = 'YouTubeNotConnectedError';
    }
}

export class YouTubeChannelInUseError extends Error {
    constructor() {
        super('This YouTube channel is already connected to another workspace. Disconnect it there first.');
        this.name = 'YouTubeChannelInUseError';
    }
}

// ─── OAuth state ────────────────────────────────────────────────────────────────────────

/** A single-use state for one tenant + user, dead after ten minutes. */
export async function createOAuthState(creatorId: string, userId: string | null): Promise<string> {
    const nonce = crypto.randomBytes(32).toString('base64url');
    await queryCount(`DELETE FROM oauth_states WHERE expires_at < NOW() - INTERVAL '1 day'`);
    await queryCount(
        `INSERT INTO oauth_states (nonce, platform, creator_id, user_id, expires_at)
         VALUES ($1, 'youtube', $2, $3, $4)`,
        [nonce, creatorId, userId, new Date(Date.now() + OAUTH_STATE_TTL_MS)]
    );
    return nonce;
}

/** Consume a state: at most once, before it expires, and only one minted for YouTube. */
export async function consumeOAuthState(nonce: string): Promise<{ creatorId: string; userId: string | null } | null> {
    const row = await queryOne<{ creator_id: string; user_id: string | null }>(
        `UPDATE oauth_states
            SET used_at = NOW()
          WHERE nonce = $1 AND platform = 'youtube' AND used_at IS NULL AND expires_at > NOW()
      RETURNING creator_id, user_id`,
        [nonce]
    );
    return row ? { creatorId: row.creator_id, userId: row.user_id } : null;
}

// ─── Reading ────────────────────────────────────────────────────────────────────────────

export async function getConnection(creatorId: string): Promise<PlatformConnectionRow | null> {
    return queryOne<PlatformConnectionRow>(
        `SELECT * FROM platform_connections WHERE creator_id = $1 AND platform = 'youtube'`,
        [creatorId]
    );
}

/** What the dashboard may see. Never a token. */
export interface YouTubeConnectionSummary {
    connected: boolean;
    status: PlatformConnectionRow['status'] | null;
    channelId: string | null;
    channelTitle: string | null;
    thumbnailUrl: string | null;
    /** Google lets the user untick a scope on the consent screen; without this one nothing uploads. */
    canUpload: boolean;
    scopes: string[];
    /** Set only while the Google app is in Testing: the login dies then (7 days). */
    refreshExpiresAt: string | null;
    lastRefreshedAt: string | null;
    lastError: string | null;
    connectedAt: string | null;
}

export function summariseConnection(row: PlatformConnectionRow | null): YouTubeConnectionSummary {
    const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
    if (!row) {
        return {
            connected: false, status: null, channelId: null, channelTitle: null, thumbnailUrl: null,
            canUpload: false, scopes: [], refreshExpiresAt: null, lastRefreshedAt: null, lastError: null, connectedAt: null,
        };
    }
    const scopes = row.scopes ?? [];
    return {
        connected: row.status === 'active' && Boolean(row.refresh_token),
        status: row.status,
        channelId: row.external_account_id,
        channelTitle: row.display_name,
        thumbnailUrl: row.avatar_url,
        canUpload: scopes.includes(SCOPE_UPLOAD),
        // Shown short: `youtube.upload`, not the whole URL.
        scopes: scopes.map((s) => s.replace('https://www.googleapis.com/auth/', '')),
        refreshExpiresAt: iso(row.refresh_expires_at),
        lastRefreshedAt: iso(row.last_refreshed_at),
        lastError: row.last_error,
        connectedAt: iso(row.created_at),
    };
}

// ─── Connecting ─────────────────────────────────────────────────────────────────────────

/**
 * Finish the OAuth round trip: exchange the code, read the channel, store both. A reconnect
 * replaces the tenant's connection in place. The channel read is not optional here, unlike
 * TikTok's profile: the channel id is what the row is keyed by.
 */
export async function completeConnection(input: {
    creatorId: string; userId: string | null; code: string; redirectUri: string;
}): Promise<PlatformConnectionRow> {
    const app = await getYouTubeAppConfig();
    if (!app) throw new Error('The YouTube app (Google OAuth client) is not configured.');

    const tokens = await exchangeCode({
        clientId: app.clientId, clientSecret: app.clientSecret, code: input.code, redirectUri: input.redirectUri,
    });
    if (!tokens.refreshToken) {
        // `prompt=consent` should always produce one; without it the connection would die in an hour.
        throw new Error('Google returned no refresh token — remove the app at myaccount.google.com/permissions and connect again.');
    }
    const channel = await getMyChannel(tokens.accessToken);

    try {
        const row = await queryOne<PlatformConnectionRow>(
            `INSERT INTO platform_connections (
                 creator_id, platform, external_account_id, display_name, avatar_url, scopes,
                 access_token, access_expires_at, refresh_token, refresh_expires_at,
                 status, last_error, last_refreshed_at, refresh_claimed_at, connected_by_user_id
             ) VALUES ($1, 'youtube', $2, $3, $4, $5, $6, $7, $8, $9, 'active', NULL, NOW(), NULL, $10)
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
                input.creatorId, channel.id, channel.handle ? `${channel.title ?? ''} (${channel.handle})`.trim() : channel.title,
                channel.thumbnailUrl, tokens.scopes,
                encryptSecret(tokens.accessToken), tokens.accessExpiresAt,
                encryptSecret(tokens.refreshToken), tokens.refreshExpiresAt,
                input.userId,
            ]
        );
        if (!row) throw new Error('Saving the YouTube connection returned no row.');
        return row;
    } catch (err: any) {
        // uq_platform_connections_account: the same channel on another tenant.
        if (err?.code === '23505') throw new YouTubeChannelInUseError();
        throw err;
    }
}

// ─── Using ──────────────────────────────────────────────────────────────────────────────

export function isFresh(row: Pick<PlatformConnectionRow, 'access_token' | 'access_expires_at'>, now: number): boolean {
    return Boolean(row.access_token)
        && row.access_expires_at !== null
        && new Date(row.access_expires_at).getTime() - now > REFRESH_MARGIN_MS;
}

/**
 * Google refused the login: access was removed (from the dashboard elsewhere, or at
 * myaccount.google.com/permissions), or a Testing app's 7 days ran out. The tokens and the channel's
 * name and picture are deleted now — YouTube's developer policies want a user's data gone soon after
 * they revoke access, and /privacy says it happens at the next daily check. The channel id stays,
 * with the reason, so Settings can ask for a reconnect; Disconnect removes the row.
 */
export async function markConnectionInvalid(connectionId: string, reason: string): Promise<void> {
    await queryCount(
        `UPDATE platform_connections
            SET status = 'invalid', last_error = $2, access_token = NULL, access_expires_at = NULL,
                refresh_token = NULL, refresh_expires_at = NULL, display_name = NULL, avatar_url = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [connectionId, reason.slice(0, 500)]
    );
}

async function writeRefreshed(row: PlatformConnectionRow, tokens: GoogleTokenSet): Promise<PlatformConnectionRow> {
    const updated = await queryOne<PlatformConnectionRow>(
        `UPDATE platform_connections
            SET access_token = $2, access_expires_at = $3,
                refresh_token = COALESCE($4, refresh_token),
                refresh_expires_at = CASE WHEN $4::text IS NULL THEN refresh_expires_at ELSE $5 END,
                scopes = CASE WHEN cardinality($6::text[]) > 0 THEN $6::text[] ELSE scopes END,
                status = 'active', last_error = NULL, last_refreshed_at = NOW(), updated_at = NOW()
          WHERE id = $1
      RETURNING *`,
        [
            row.id, encryptSecret(tokens.accessToken), tokens.accessExpiresAt,
            tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null, tokens.refreshExpiresAt, tokens.scopes,
        ]
    );
    if (!updated) throw new YouTubeNotConnectedError('The YouTube connection was removed during a refresh.');
    return updated;
}

/** Refresh one connection. Marks it invalid when Google refuses the refresh token. */
async function refresh(row: PlatformConnectionRow): Promise<PlatformConnectionRow> {
    const app = await getYouTubeAppConfig();
    if (!app) throw new Error('The YouTube app (Google OAuth client) is not configured.');
    try {
        const tokens = await refreshAccessToken({
            clientId: app.clientId, clientSecret: app.clientSecret, refreshToken: decryptSecret(row.refresh_token),
        });
        return await writeRefreshed(row, tokens);
    } catch (err) {
        if (isYouTubeReauthError(err)) {
            await markConnectionInvalid(row.id, (err as Error).message);
            log('warn', 'youtube.token_refresh_refused', { connection_id: row.id, ...describeError(err) });
            throw new YouTubeNotConnectedError((err as Error).message);
        }
        throw err;
    }
}

/** A working access token for this tenant, refreshed when its hour is nearly up. */
export async function getAccessToken(creatorId: string): Promise<{ accessToken: string; connection: PlatformConnectionRow }> {
    const row = await getConnection(creatorId);
    if (row?.status === 'invalid') {
        throw new YouTubeNotConnectedError(row.last_error ?? 'The YouTube connection needs to be reconnected in Settings.');
    }
    if (!row || row.status !== 'active' || !row.refresh_token) throw new YouTubeNotConnectedError();
    if (isFresh(row, Date.now())) return { accessToken: decryptSecret(row.access_token), connection: row };
    const refreshed = await refresh(row);
    return { accessToken: decryptSecret(refreshed.access_token), connection: refreshed };
}

/** A failed API call that says the login is dead: mark it so Settings asks for a reconnect. */
export async function noteYouTubeFailure(connectionId: string | null, err: unknown): Promise<void> {
    if (!connectionId || !isYouTubeReauthError(err)) return;
    try {
        await markConnectionInvalid(connectionId, (err as Error).message);
    } catch (writeErr) {
        log('error', 'youtube.note_failure_failed', describeError(writeErr));
    }
}

/**
 * The daily check: refresh every active connection and re-read its channel, so a removed or
 * expired login is found by the cron rather than the next Short, and the stored channel name and
 * picture stay fresh. Cannot throw.
 */
export async function refreshAllYouTubeConnections(): Promise<{ refreshed: number; failed: number }> {
    let refreshed = 0;
    let failed = 0;
    let rows: PlatformConnectionRow[] = [];
    try {
        rows = await queryRows<PlatformConnectionRow>(
            `SELECT * FROM platform_connections
              WHERE platform = 'youtube' AND status = 'active' AND refresh_token IS NOT NULL
              ORDER BY last_refreshed_at NULLS FIRST
              LIMIT 50`
        );
    } catch (err) {
        log('error', 'youtube.refresh_sweep_failed', describeError(err));
        return { refreshed, failed };
    }
    for (const row of rows) {
        try {
            const fresh = await refresh(row);
            refreshed++;
            if ((fresh.scopes ?? []).includes(SCOPE_READONLY)) {
                const channel = await getMyChannel(decryptSecret(fresh.access_token));
                await queryCount(
                    `UPDATE platform_connections SET display_name = $2, avatar_url = $3, updated_at = NOW() WHERE id = $1`,
                    [row.id, channel.handle ? `${channel.title ?? ''} (${channel.handle})`.trim() : channel.title, channel.thumbnailUrl]
                );
            }
        } catch (err) {
            failed++;
            log('warn', 'youtube.refresh_sweep_row_failed', { connection_id: row.id, ...describeError(err) });
        }
    }
    return { refreshed, failed };
}

// ─── Disconnecting ──────────────────────────────────────────────────────────────────────

/**
 * Revoke with Google (best-effort: a login Google already dropped cannot be revoked, and that must
 * not trap the owner with a connection they cannot remove), then delete the row and its tokens.
 */
export async function disconnect(creatorId: string): Promise<{ removed: boolean; revoked: boolean }> {
    const row = await getConnection(creatorId);
    if (!row) return { removed: false, revoked: false };
    let revoked = false;
    const token = row.refresh_token ? decryptSecret(row.refresh_token) : row.access_token ? decryptSecret(row.access_token) : '';
    if (token) {
        try {
            await revokeToken(token);
            revoked = true;
        } catch (err) {
            log('warn', 'youtube.revoke_failed', { connection_id: row.id, ...describeError(err) });
        }
    }
    await queryCount('DELETE FROM platform_connections WHERE id = $1', [row.id]);
    return { removed: true, revoked };
}
