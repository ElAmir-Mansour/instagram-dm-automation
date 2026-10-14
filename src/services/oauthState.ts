/**
 * OAuth state, for every connect flow: TikTok, YouTube and Meta.
 *
 * Dashboard sessions are Bearer tokens in localStorage, so the provider's redirect back to us carries no session at all. What
 * binds a returned `code` to a tenant is a row in `oauth_states`, and what binds that row to the browser that began the flow is
 * the same value in an HttpOnly cookie scoped to the callback path:
 *
 *   - a nonce is 32 random bytes, in the table with the tenant and the user who asked, and dies after ten minutes;
 *   - it is SPENT in one `UPDATE … WHERE used_at IS NULL AND expires_at > NOW() RETURNING`, so two callbacks carrying the same
 *     state cannot both win, and the check and the spend are one statement;
 *   - the callback requires cookie == state BEFORE it spends anything, so a state lifted from a log or a referrer and replayed
 *     in another browser fails without burning the legitimate one.
 *
 * This module was three copies of the first two points (tiktokConnections.ts, youtubeConnections.ts, which now call it) and is
 * where the Meta flow adds the other two things it needs:
 *
 *   `return_to`  where the callback sends the browser back to (Settings, or the setup wizard);
 *   `payload`    encrypted JSON. For purpose `meta` it is what the connect asked for (a reconnect). For purpose `meta_pick` it is
 *                the list of Pages the user may choose from, each WITH its Page access token. A choice (`consumePick`) sets it to
 *                NULL in the statement that spends the row, and `purgeOAuthStates` NULLs the ones nobody chose, so a Page token
 *                sits in this table for the minutes it is needed and no longer.
 *
 * TikTok and YouTube never touch the v35 columns (`payload`, `return_to`): their statements read and write exactly the columns
 * v18 gave them, so a deployment that runs ahead of its migration still connects them.
 */
import crypto from 'crypto';
import { decryptSecret, encryptSecret } from '../config/crypto.js';
import { queryCount, queryOne } from '../db/query.js';

/** How long an OAuth round trip, or a Page pick, may take. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * What a state is for, stored in `oauth_states.platform`: a state minted for one purpose cannot be spent for another.
 * `meta_pick` is not a platform: it is the second half of the Meta flow, the Pages waiting for a choice.
 */
export type OAuthPurpose = 'tiktok' | 'youtube' | 'meta' | 'meta_pick';

/** Where the callback sends the browser back to. The dashboard's router reads the outcome from the hash query of either. */
export type OAuthReturnTo = 'settings' | 'welcome';

const RETURN_TO: readonly OAuthReturnTo[] = ['settings', 'welcome'];

export function isReturnTo(value: unknown): value is OAuthReturnTo {
    return typeof value === 'string' && (RETURN_TO as readonly string[]).includes(value);
}

/** The purposes whose rows carry the v35 columns. The others are written and read as before v35. */
function usesV35(purpose: OAuthPurpose): boolean {
    return purpose === 'meta' || purpose === 'meta_pick';
}

/** What `state` looks like when we made it: 32 random bytes, base64url. Anything else is not ours and never reaches SQL. */
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;

export interface NewOAuthState {
    purpose: OAuthPurpose;
    creatorId: string;
    /** Null for a legacy shared-password session, which has no user row. */
    userId: string | null;
    /** Meta only. */
    returnTo?: OAuthReturnTo | null;
    /** Meta only. Encrypted before it is stored. */
    payload?: unknown;
    ttlMs?: number;
}

/**
 * Mint a single-use state. Also sweeps states that expired over a day ago, so the table never needs a job of its own; a Meta
 * state also clears the payload of any that expired unspent (a Page pick nobody finished), which is the part that holds tokens.
 */
export async function createOAuthState(input: NewOAuthState): Promise<string> {
    const { purpose } = input;
    const v35 = usesV35(purpose);
    if (!v35 && (input.returnTo || input.payload !== undefined)) {
        throw new Error(`A ${purpose} state carries no return_to or payload.`);
    }

    const nonce = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + (input.ttlMs ?? OAUTH_STATE_TTL_MS));

    await queryCount(`DELETE FROM oauth_states WHERE expires_at < NOW() - INTERVAL '1 day'`);
    if (!v35) {
        await queryCount(
            `INSERT INTO oauth_states (nonce, platform, creator_id, user_id, expires_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [nonce, purpose, input.creatorId, input.userId, expires]
        );
        return nonce;
    }

    await queryCount(`UPDATE oauth_states SET payload = NULL WHERE payload IS NOT NULL AND expires_at < NOW()`);
    await queryCount(
        `INSERT INTO oauth_states (nonce, platform, creator_id, user_id, expires_at, return_to, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
            nonce, purpose, input.creatorId, input.userId, expires,
            input.returnTo ?? null,
            input.payload === undefined ? null : encryptSecret(JSON.stringify(input.payload)),
        ]
    );
    return nonce;
}

export interface ConsumedOAuthState {
    creatorId: string;
    userId: string | null;
    /** Meta only: null for TikTok and YouTube, whose callback always returns to Settings. */
    returnTo: OAuthReturnTo | null;
    /** Meta only: what `createOAuthState` was given, or null when there was none or it cannot be read. */
    payload: unknown;
}

interface ConsumedRow {
    creator_id: string;
    user_id: string | null;
    return_to?: string | null;
    payload?: string | null;
}

function toConsumed(row: ConsumedRow): ConsumedOAuthState {
    return {
        creatorId: row.creator_id,
        userId: row.user_id,
        returnTo: isReturnTo(row.return_to) ? row.return_to : null,
        payload: openPayload(row.payload),
    };
}

/**
 * Consume a state: succeeds at most once, only before it expires, and only for the purpose it was minted for. The UPDATE is the
 * check: two concurrent callbacks carrying the same state cannot both match `used_at IS NULL`.
 */
export async function consumeOAuthState(nonce: string, purpose: OAuthPurpose): Promise<ConsumedOAuthState | null> {
    const row = await queryOne<ConsumedRow>(
        `UPDATE oauth_states
            SET used_at = NOW()
          WHERE nonce = $1 AND platform = $2 AND used_at IS NULL AND expires_at > NOW()
      RETURNING creator_id, user_id${usesV35(purpose) ? ', return_to, payload' : ''}`,
        [nonce, purpose]
    );
    return row ? toConsumed(row) : null;
}

/**
 * Open a stored payload. A payload that cannot be read (a rotated key, a damaged row) is nothing, not an exception: every reader
 * treats "nothing" as the safe answer (a connect that asked for no reconnect, a pick that has expired).
 */
function openPayload(stored: string | null | undefined): unknown {
    if (!stored) return null;
    try {
        return JSON.parse(decryptSecret(stored));
    } catch {
        return null;
    }
}

// ─── The Page pick ──────────────────────────────────────────────────────────────────────

export interface PickState {
    payload: unknown;
    returnTo: OAuthReturnTo | null;
    expiresAt: Date;
}

/** A user for `user_id IS NOT DISTINCT FROM`: NULL for a legacy session, whose rows have a NULL user_id too. */
const asUser = (userId: string | null): string | null => userId ?? null;

/**
 * Read a Page pick WITHOUT spending it, for the person who made it: the same tenant and the same user, else nothing (the route
 * answers 404, so another tenant cannot tell a pick exists). `nonce` must look like one of ours.
 */
export async function readPick(nonce: string, creatorId: string, userId: string | null): Promise<PickState | null> {
    if (!NONCE_PATTERN.test(nonce)) return null;
    const row = await queryOne<{ payload: string | null; return_to: string | null; expires_at: Date }>(
        `SELECT payload, return_to, expires_at
           FROM oauth_states
          WHERE nonce = $1 AND platform = 'meta_pick' AND creator_id = $2 AND user_id IS NOT DISTINCT FROM $3::uuid
            AND used_at IS NULL AND expires_at > NOW() AND payload IS NOT NULL`,
        [nonce, creatorId, asUser(userId)]
    );
    if (!row) return null;
    const payload = openPayload(row.payload);
    if (payload === null) return null;
    return { payload, returnTo: isReturnTo(row.return_to) ? row.return_to : null, expiresAt: row.expires_at };
}

/**
 * Spend a Page pick and hand back what it held, in ONE statement that also sets `payload` to NULL: the Page tokens are gone from
 * the table at the moment of the choice, whatever happens next. The CTE reads the row's payload as it was before the UPDATE.
 * `FOR UPDATE` makes a second, concurrent choice wait and then find the row spent.
 */
export async function consumePick(nonce: string, creatorId: string, userId: string | null): Promise<PickState | null> {
    if (!NONCE_PATTERN.test(nonce)) return null;
    const row = await queryOne<{ payload: string | null; return_to: string | null; expires_at: Date }>(
        `WITH picked AS (
             SELECT nonce, payload, return_to, expires_at
               FROM oauth_states
              WHERE nonce = $1 AND platform = 'meta_pick' AND creator_id = $2 AND user_id IS NOT DISTINCT FROM $3::uuid
                AND used_at IS NULL AND expires_at > NOW()
                FOR UPDATE
         )
         UPDATE oauth_states o
            SET used_at = NOW(), payload = NULL
           FROM picked
          WHERE o.nonce = picked.nonce
      RETURNING picked.payload AS payload, picked.return_to AS return_to, picked.expires_at AS expires_at`,
        [nonce, creatorId, asUser(userId)]
    );
    if (!row) return null;
    const payload = openPayload(row.payload);
    if (payload === null) return null;
    return { payload, returnTo: isReturnTo(row.return_to) ? row.return_to : null, expiresAt: row.expires_at };
}

/**
 * The housekeeping the daily cron runs: clear the payload of every state that is spent or expired, and delete the rows that
 * expired over a day ago. Cannot throw into the cron that calls it.
 */
export async function purgeOAuthStates(): Promise<{ scrubbed: number; deleted: number }> {
    const scrubbed = await queryCount(
        `UPDATE oauth_states SET payload = NULL WHERE payload IS NOT NULL AND (used_at IS NOT NULL OR expires_at < NOW())`
    );
    const deleted = await queryCount(`DELETE FROM oauth_states WHERE expires_at < NOW() - INTERVAL '1 day'`);
    return { scrubbed, deleted };
}

// ─── The cookie ─────────────────────────────────────────────────────────────────────────

/**
 * The cookie that carries a state through the provider's round trip, so it can only complete in the browser that began it.
 * Path-scoped to the callback: no other route ever sees it. Lax, because the callback is a top-level navigation from the
 * provider's domain: Strict would drop it on exactly that request. `maxAgeSeconds` 0 clears it.
 */
export function stateCookie(name: string, path: string, value: string, maxAgeSeconds: number): string {
    return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
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
