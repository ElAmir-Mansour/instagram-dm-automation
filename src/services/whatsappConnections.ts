/**
 * WhatsApp connections: the one `platform_connections` row (`platform = 'whatsapp'`) a tenant's number lives in, its token, and what Meta
 * said about it. The only module that reads or writes that token, for the reason `tiktokConnections.ts` and `tenant.ts` give for theirs:
 * decryption happens in one place, so no path can send `enc:v1:…` to Meta as a bearer token, and no path can return one to a browser.
 *
 * The row (docs/specs/001-whatsapp-agent/data-model.md):
 *
 *   external_account_id   the `phone_number_id`. UNIQUE per platform, so an inbound webhook names exactly one tenant
 *   display_name          Meta's `verified_name`, refreshed with the health read
 *   access_token          the system-user token, `enc:v1:` (AES-256-GCM). NULL once the owner disconnects
 *   access_expires_at     NULL for a token that never expires (`debug_token`'s `expires_at: 0`)
 *   status                `active` | `invalid` | `revoked` and nothing else (the CHECK at migration_v18). `invalid`: Meta refused the token
 *                         or a permission (inbound messages are still STORED, nothing is sent); `revoked`: the owner disconnected
 *   profile (JSONB)       FACTS READ FROM META — `WhatsAppProfile`. Never typed by hand, except `waba_id`, which Meta cannot be asked for
 *   settings (JSONB, v50) THE OWNER'S CHOICES — `WhatsAppSettings`: `{ allow_billable: false, free_tier_alert_at: 900 }`
 *
 * Reads never select the token columns except `getAccessToken`, so the typed `WhatsAppConnection` the rest of the app sees cannot carry one
 * even by mistake. One WhatsApp number per tenant (`UNIQUE (creator_id, platform)`): reconnecting replaces it in place.
 *
 * `getConnectionByPhoneNumberId` is the tenant lookup for the webhook (`getCreatorByWhatsAppNumber`): it answers for any row that is not `revoked`,
 * because an `invalid` connection must still STORE what arrives — Meta never redelivers it.
 */
import { decryptSecret, encryptSecret } from '../config/crypto.js';
import { queryCount, queryOne } from '../db/query.js';
import type { ConnectionStatus, PlatformConnectionRow } from '../db/rows.js';
import { describeError, log } from '../utils/log.js';
import { fetchDebugToken } from './tokenHealth.js';
import { metaErrorCode } from './http.js';
import { getPhoneNumberHealth, inspectWhatsAppToken, type PhoneNumberHealth } from './whatsapp.js';

// ─── The shapes the JSONB columns hold ──────────────────────────────────────────────────

/**
 * Why Meta, not the token, stopped a connection (an `account_update` event, `whatsappAccount.ts`): the account was deleted or taken off this
 * app, the number is restricted from replying, or the account is disabled. Kept in `profile.account_block` so a valid token does not undo it
 * (`refreshHealth`): only Meta saying it is over (a reconnect or reinstate event, or the restriction's own end) clears it.
 */
export type AccountBlock = 'deleted' | 'offboarded' | 'disconnected' | 'restricted' | 'banned';

export const ACCOUNT_BLOCKS: readonly AccountBlock[] = ['deleted', 'offboarded', 'disconnected', 'restricted', 'banned'];

/** What a connection keeps of what Meta said. Written by `connect` and every health read; the keys are the data model's. */
export interface WhatsAppProfile {
    /** The Messaging account (the old WABA) id. Typed by the owner at connect: Meta's answer for a phone number does not name it. */
    waba_id: string | null;
    /** The WhatsApp-account id of Meta's new account model (phase 3, H1 2028). Not read yet. */
    waac_id: string | null;
    display_phone_number: string | null;
    quality_rating: string | null;
    messaging_limit: string | null;
    name_status: string | null;
    code_verification_status: string | null;
    throughput: string | null;
    /** The number's operating status (CONNECTED, FLAGGED, RESTRICTED …), when Meta served it. */
    number_status: string | null;
    is_test_number: boolean;
    /** The Messaging account's timezone, for the usage period. Not read yet (a later phase); null until then. */
    timezone: string | null;
    /** ISO time the facts were read. */
    read_at: string | null;
    /** Present only while Meta has blocked the account (see `AccountBlock`); absent otherwise, so a profile without a block is unchanged. */
    account_block?: AccountBlock;
    /** ISO time a `restricted` block ends. Absent for one with no stated end. */
    block_until?: string;
}

export const EMPTY_PROFILE: WhatsAppProfile = {
    waba_id: null, waac_id: null, display_phone_number: null, quality_rating: null, messaging_limit: null, name_status: null,
    code_verification_status: null, throughput: null, number_status: null, is_test_number: false, timezone: null, read_at: null,
};

/** A stored profile, read defensively: JSON that code wrote, but a column edited by hand or by a later version is not trusted to be this shape. */
export function readProfile(value: unknown): WhatsAppProfile {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_PROFILE };
    const v = value as Record<string, unknown>;
    const text = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x : null);
    return {
        waba_id: text(v.waba_id),
        waac_id: text(v.waac_id),
        display_phone_number: text(v.display_phone_number),
        quality_rating: text(v.quality_rating),
        messaging_limit: text(v.messaging_limit),
        name_status: text(v.name_status),
        code_verification_status: text(v.code_verification_status),
        throughput: text(v.throughput),
        number_status: text(v.number_status),
        is_test_number: v.is_test_number === true,
        timezone: text(v.timezone),
        read_at: text(v.read_at),
        ...(isAccountBlock(v.account_block) ? { account_block: v.account_block } : {}),
        ...(isAccountBlock(v.account_block) && text(v.block_until) ? { block_until: text(v.block_until)! } : {}),
    };
}

export const isAccountBlock = (value: unknown): value is AccountBlock => typeof value === 'string' && (ACCOUNT_BLOCKS as readonly string[]).includes(value);

/**
 * The block that still holds at `now`, or null: none recorded, or a `restricted` one whose end has passed. An expired restriction is the one
 * block Meta never announces the end of, so the clock is what lifts it.
 */
export function activeAccountBlock(profile: Pick<WhatsAppProfile, 'account_block' | 'block_until'>, now: Date = new Date()): AccountBlock | null {
    if (!profile.account_block) return null;
    if (profile.account_block === 'restricted' && profile.block_until) {
        const until = Date.parse(profile.block_until);
        if (Number.isFinite(until) && until <= now.getTime()) return null;
    }
    return profile.account_block;
}

/** Meta's health read as the `profile` keys it fills. Not `waba_id` (typed) and not `timezone` (not read). */
export function profileFacts(health: PhoneNumberHealth, readAt: Date = new Date()): Partial<WhatsAppProfile> {
    return {
        display_phone_number: health.displayPhoneNumber,
        quality_rating: health.qualityRating,
        messaging_limit: health.messagingLimit,
        name_status: health.nameStatus,
        code_verification_status: health.codeVerificationStatus,
        throughput: health.throughput,
        number_status: health.numberStatus,
        is_test_number: health.isTestNumber,
        read_at: readAt.toISOString(),
    };
}

/** Meta's free tier: delivered service messages per month, per number. */
export const FREE_REPLIES_PER_MONTH = 1000;

/** The owner's choices for the connection. `allow_billable` false blocks any send that Meta would charge for (FR-033). */
export interface WhatsAppSettings {
    allow_billable: boolean;
    /** Warn the owner when this many of the free replies are used. */
    free_tier_alert_at: number;
}

export const DEFAULT_WHATSAPP_SETTINGS: Readonly<WhatsAppSettings> = Object.freeze({ allow_billable: false, free_tier_alert_at: 900 });

/**
 * The settings from the JSONB column, with a default for anything missing or malformed. Fails toward the safe side: only a literal `true`
 * allows billable sends, and a threshold that is not a whole number in 0..1000 is the default.
 */
export function readSettings(value: unknown): WhatsAppSettings {
    const v = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
    return {
        allow_billable: v.allow_billable === true,
        free_tier_alert_at: isAlertThreshold(v.free_tier_alert_at) ? v.free_tier_alert_at : DEFAULT_WHATSAPP_SETTINGS.free_tier_alert_at,
    };
}

export const isAlertThreshold = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= FREE_REPLIES_PER_MONTH;

// ─── Reading ────────────────────────────────────────────────────────────────────────────

/** What every other part of the app sees of a connection. There is no token field: `hasToken` says whether one is stored. */
export interface WhatsAppConnection {
    id: string;
    creatorId: string;
    phoneNumberId: string;
    displayName: string | null;
    status: ConnectionStatus;
    lastError: string | null;
    scopes: string[];
    hasToken: boolean;
    /** ISO, or null for a token that never expires. */
    accessExpiresAt: string | null;
    lastRefreshedAt: string | null;
    connectedAt: string | null;
    profile: WhatsAppProfile;
    settings: WhatsAppSettings;
}

/** Raised when there is no usable connection: never connected, disconnected, or (for a send) refused by Meta. */
export class WhatsAppNotConnectedError extends Error {
    constructor(message = 'WhatsApp is not connected for this account — connect it in Settings.') {
        super(message);
        this.name = 'WhatsAppNotConnectedError';
    }
}

/** Raised when the phone number is already attached to a different tenant. */
export class WhatsAppNumberInUseError extends Error {
    constructor() {
        super('This WhatsApp number is already connected to another workspace. Disconnect it there first.');
        this.name = 'WhatsAppNumberInUseError';
    }
}

/** The columns a connection is read from. The token is NOT one of them. */
const COLUMNS = `id, creator_id, external_account_id, display_name, status, last_error, scopes,
                 access_token IS NOT NULL AS has_token, access_expires_at, last_refreshed_at, created_at, profile, settings`;

type Row = Pick<PlatformConnectionRow, 'id' | 'creator_id' | 'external_account_id' | 'display_name' | 'status' | 'last_error' | 'scopes'
    | 'access_expires_at' | 'last_refreshed_at' | 'created_at' | 'profile' | 'settings'> & { has_token: boolean };

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

function toConnection(row: Row): WhatsAppConnection {
    return {
        id: row.id,
        creatorId: row.creator_id,
        phoneNumberId: row.external_account_id,
        displayName: row.display_name,
        status: row.status,
        lastError: row.last_error,
        scopes: row.scopes ?? [],
        hasToken: row.has_token === true,
        accessExpiresAt: iso(row.access_expires_at),
        lastRefreshedAt: iso(row.last_refreshed_at),
        connectedAt: iso(row.created_at),
        profile: readProfile(row.profile),
        settings: readSettings(row.settings),
    };
}

/** The tenant's WhatsApp connection, whatever its status (a `revoked` row is the tombstone of a disconnect), or null. */
export async function getConnection(creatorId: string): Promise<WhatsAppConnection | null> {
    const row = await queryOne<Row>(
        `SELECT ${COLUMNS} FROM platform_connections WHERE creator_id = $1 AND platform = 'whatsapp'`,
        [creatorId]
    );
    return row ? toConnection(row) : null;
}

/**
 * The connection a webhook for this `phone_number_id` belongs to: any row that is not `revoked`. An `invalid` one is returned on purpose —
 * it still stores inbound messages (Meta never redelivers them) and only skips sending.
 */
export async function getConnectionByPhoneNumberId(phoneNumberId: string): Promise<WhatsAppConnection | null> {
    const row = await queryOne<Row>(
        `SELECT ${COLUMNS} FROM platform_connections
          WHERE platform = 'whatsapp' AND external_account_id = $1 AND status <> 'revoked'`,
        [phoneNumberId]
    );
    return row ? toConnection(row) : null;
}

/**
 * The decrypted token, with the connection it belongs to. The only way a plaintext token leaves this module, and it goes to a caller that
 * is about to put it in an `Authorization` header.
 *
 * Throws `WhatsAppNotConnectedError` when there is no row, it was disconnected, it holds no token, or it is `invalid` — a connection Meta
 * refused is not sent through. `allowInvalid` is for the one caller that is asking Meta whether it has recovered (the refresh).
 */
export async function getAccessToken(
    creatorId: string,
    opts: { allowInvalid?: boolean } = {}
): Promise<{ accessToken: string; connection: WhatsAppConnection }> {
    const row = await queryOne<Row & { access_token: string | null }>(
        `SELECT ${COLUMNS}, access_token FROM platform_connections WHERE creator_id = $1 AND platform = 'whatsapp'`,
        [creatorId]
    );
    if (!row || row.status === 'revoked' || !row.access_token) throw new WhatsAppNotConnectedError();
    if (row.status === 'invalid' && !opts.allowInvalid) {
        throw new WhatsAppNotConnectedError(row.last_error ?? 'The WhatsApp connection needs to be reconnected in Settings.');
    }
    return { accessToken: decryptSecret(row.access_token), connection: toConnection(row) };
}

// ─── Writing ────────────────────────────────────────────────────────────────────────────

export interface SaveConnectionInput {
    creatorId: string;
    userId: string | null;
    phoneNumberId: string;
    wabaId: string;
    accessToken: string;
    health: PhoneNumberHealth;
    scopes: readonly string[];
    /** From `debug_token`; null for a token that never expires. */
    accessExpiresAt: Date | null;
}

/**
 * Store a validated connection. Reconnecting replaces the tenant's row in place (`UNIQUE (creator_id, platform)`).
 *
 *   - The owner's `settings` survive a reconnect of the SAME number and are reset when the number changes: agreeing to billable replies for
 *     one number says nothing about another.
 *   - Another tenant's `revoked` row for this number is a tombstone holding no data; it is deleted first, or it would reserve the number
 *     forever through the unique index. A live row of another tenant is `WhatsAppNumberInUseError`.
 *   - The token is encrypted here and nowhere else.
 */
export async function saveConnection(input: SaveConnectionInput): Promise<WhatsAppConnection> {
    await queryCount(
        `DELETE FROM platform_connections
          WHERE platform = 'whatsapp' AND external_account_id = $1 AND status = 'revoked' AND creator_id <> $2`,
        [input.phoneNumberId, input.creatorId]
    );

    const profile: WhatsAppProfile = {
        ...EMPTY_PROFILE, ...profileFacts(input.health), waba_id: input.wabaId,
    };
    try {
        const row = await queryOne<Row>(
            `INSERT INTO platform_connections (
                 creator_id, platform, external_account_id, display_name, scopes,
                 access_token, access_expires_at, refresh_token, refresh_expires_at,
                 status, last_error, last_refreshed_at, refresh_claimed_at, connected_by_user_id, profile
             ) VALUES ($1, 'whatsapp', $2, $3, $4, $5, $6, NULL, NULL, 'active', NULL, NOW(), NULL, $7, $8::jsonb)
             ON CONFLICT (creator_id, platform) DO UPDATE SET
                 settings = CASE WHEN platform_connections.external_account_id = EXCLUDED.external_account_id
                                 THEN platform_connections.settings ELSE '{}'::jsonb END,
                 external_account_id = EXCLUDED.external_account_id,
                 display_name = EXCLUDED.display_name,
                 scopes = EXCLUDED.scopes,
                 access_token = EXCLUDED.access_token,
                 access_expires_at = EXCLUDED.access_expires_at,
                 status = 'active', last_error = NULL, last_refreshed_at = NOW(),
                 connected_by_user_id = EXCLUDED.connected_by_user_id,
                 profile = EXCLUDED.profile,
                 updated_at = NOW()
             RETURNING ${COLUMNS}`,
            [
                input.creatorId, input.phoneNumberId, input.health.verifiedName, [...input.scopes],
                encryptSecret(input.accessToken), input.accessExpiresAt, input.userId, JSON.stringify(profile),
            ]
        );
        if (!row) throw new Error('Saving the WhatsApp connection returned no row.');
        return toConnection(row);
    } catch (err: any) {
        // uq_platform_connections_account: this phone_number_id belongs to another tenant's live row. Webhooks name the number, so one
        // number cannot belong to two tenants.
        if (err?.code === '23505') throw new WhatsAppNumberInUseError();
        throw err;
    }
}

/** Merge Meta's latest facts into the profile (keys it does not name — `waba_id` — are kept) and note the read. Null when the row is gone. */
export async function updateHealth(connectionId: string, health: PhoneNumberHealth): Promise<WhatsAppConnection | null> {
    const row = await queryOne<Row>(
        `UPDATE platform_connections
            SET display_name = COALESCE($2, display_name),
                profile = COALESCE(profile, '{}'::jsonb) || $3::jsonb,
                last_refreshed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND platform = 'whatsapp' AND status <> 'revoked'
      RETURNING ${COLUMNS}`,
        [connectionId, health.verifiedName, JSON.stringify(profileFacts(health))]
    );
    return row ? toConnection(row) : null;
}

/** Record that Meta refused this connection, so every surface shows "reconnect". Never touches a `revoked` row. */
export async function markConnectionInvalid(connectionId: string, reason: string): Promise<void> {
    await queryCount(
        `UPDATE platform_connections
            SET status = 'invalid', last_error = $2, updated_at = NOW()
          WHERE id = $1 AND platform = 'whatsapp' AND status <> 'revoked'`,
        [connectionId, reason.slice(0, 500)]
    );
}

/** A connection Meta has accepted again: `invalid` back to `active`, the reason cleared. Only ever moves an `invalid` row. */
export async function markConnectionActive(connectionId: string): Promise<void> {
    await queryCount(
        `UPDATE platform_connections
            SET status = 'active', last_error = NULL, updated_at = NOW()
          WHERE id = $1 AND platform = 'whatsapp' AND status = 'invalid'`,
        [connectionId]
    );
}

/**
 * The owner's disconnect: the token is wiped and the row kept as a `revoked` tombstone (so the webhook lookup stops matching it and the
 * history of which number it was stays). The owner's billing choice does not survive: `settings` is reset. False when there was nothing to
 * disconnect.
 */
export async function revokeConnection(creatorId: string): Promise<boolean> {
    const n = await queryCount(
        `UPDATE platform_connections
            SET access_token = NULL, access_expires_at = NULL, status = 'revoked', last_error = NULL,
                settings = '{}'::jsonb, updated_at = NOW()
          WHERE creator_id = $1 AND platform = 'whatsapp' AND status <> 'revoked'`,
        [creatorId]
    );
    return n > 0;
}

/**
 * Merge the owner's choices into `settings`. Only the keys named change. Null when there is no live connection to hold them (never connected,
 * or disconnected).
 */
export async function updateSettings(creatorId: string, patch: Partial<WhatsAppSettings>): Promise<WhatsAppConnection | null> {
    const row = await queryOne<Row>(
        `UPDATE platform_connections
            SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb, updated_at = NOW()
          WHERE creator_id = $1 AND platform = 'whatsapp' AND status <> 'revoked'
      RETURNING ${COLUMNS}`,
        [creatorId, JSON.stringify(patch)]
    );
    return row ? toConnection(row) : null;
}

// ─── Asking Meta again ──────────────────────────────────────────────────────────────────

/** Error codes that mean Meta refused the token or a permission, not that one request was wrong: 190 token, 200 and 10 permission. */
const AUTH_REFUSAL_CODES = new Set([190, 200, 10]);

/** True when a failed Graph call says the stored token or its permission is gone. */
export const isAuthRefusal = (err: unknown): boolean => AUTH_REFUSAL_CODES.has(metaErrorCode(err) ?? -1);

/**
 * Re-read the number's health from Meta and store it. Used by the Settings "refresh" button, and the daily health sweep will call it too.
 *
 *   - Meta answers: the facts are merged into the profile. A connection that was `invalid` returns to `active` only when `debug_token` also
 *     says the token is valid and carries both scopes — a successful read alone does not prove the token can send.
 *   - Meta refuses the token or a permission (190, 200, 10): the connection is marked `invalid` with Meta's words, and the error is rethrown.
 *   - Anything else (a timeout, a 5xx, a 100): the connection is left exactly as it was, and the error is rethrown. A hiccup must not flip
 *     a working connection to `invalid`.
 */
export async function refreshHealth(creatorId: string): Promise<WhatsAppConnection> {
    const { accessToken, connection } = await getAccessToken(creatorId, { allowInvalid: true });
    let health: PhoneNumberHealth;
    try {
        health = await getPhoneNumberHealth(connection.phoneNumberId, accessToken);
    } catch (err) {
        if (isAuthRefusal(err)) {
            await markConnectionInvalid(connection.id, (err as Error).message);
            log('warn', 'whatsapp.connection_invalid', { connection_id: connection.id, creator_id: creatorId, ...describeError(err) });
        }
        throw err;
    }

    let current = await updateHealth(connection.id, health);
    if (!current) throw new WhatsAppNotConnectedError('The WhatsApp connection was removed during a refresh.');

    if (current.status === 'invalid' && current.profile.account_block && !activeAccountBlock(current.profile)) {
        // The restriction's own end has passed: the block is over, and only the token is left to check below.
        await queryCount(
            `UPDATE platform_connections SET profile = COALESCE(profile, '{}'::jsonb) - 'account_block' - 'block_until', updated_at = NOW()
              WHERE id = $1 AND platform = 'whatsapp'`,
            [current.id]
        );
        const { account_block: _block, block_until: _until, ...rest } = current.profile;
        current = { ...current, profile: rest };
        log('info', 'whatsapp.account_block_expired', { connection_id: current.id, creator_id: creatorId });
    }

    if (current.status === 'invalid' && activeAccountBlock(current.profile)) {
        // Meta, not the token, stopped this connection (a restriction, a ban, a disconnection): a valid token does not undo that, and flipping
        // it back to `active` would have the agent send into an account Meta has blocked. Meta's own "reconnected" / "reinstated" event
        // (whatsappAccount.ts) or the restriction's end lifts it.
        log('info', 'whatsapp.connection_blocked', { connection_id: current.id, creator_id: creatorId, block: current.profile.account_block });
        return current;
    }

    if (current.status === 'invalid') {
        const inspection = inspectWhatsAppToken(await fetchDebugToken(accessToken), process.env.META_APP_ID?.trim() || null);
        if (!inspection.error) {
            await markConnectionActive(current.id);
            current = { ...current, status: 'active', lastError: null };
            log('info', 'whatsapp.connection_recovered', { connection_id: current.id, creator_id: creatorId });
        }
    }
    return current;
}
