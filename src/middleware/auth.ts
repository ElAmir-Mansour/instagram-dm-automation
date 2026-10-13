import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Dashboard Authentication Middleware (Stateless)
 *
 * Uses HMAC-signed tokens instead of in-memory sessions so that
 * any Vercel serverless instance can independently verify the token
 * without needing shared state.
 *
 * Token format: <payload>.<hmac_signature>
 * - payload: base64url of a JSON `SessionPayload` — who this is, which tenant they are acting
 *   as, their `token_version`, and `iat` (issued-at, unix ms)
 * - hmac_signature: HMAC-SHA256 of the payload string, keyed on
 *   `DASHBOARD_PASSWORD:META_APP_SECRET`
 *
 * This described a bare `<timestamp>.<hmac>` until the payload started carrying an identity.
 * The stale docstring was not harmless: two tests derived a "different" body with
 * `Number(body) ± n`, which is `NaN` on a base64url string, so they were rejected by the
 * signature check and never exercised the TTL they claimed to test. Removing the expiry check
 * entirely left the suite green.
 */

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * The longest a session may live, whatever it asks for: "keep me signed in" (invites, P17) is a setting the operator
 * edits, and a typo in it must not mint a token that lasts for years. `verifySession` refuses a longer one outright,
 * so the cap holds even for a token signed with a value this file would no longer issue.
 */
export const MAX_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** The lifetime of an ordinary session: what every token had before `exp` existed, and what one without it still has. */
export const DEFAULT_SESSION_TTL_MS = SESSION_TTL;

/** How long a one-shot download token stays valid — long enough for a click, short enough to be worthless in a log. */
const DOWNLOAD_TOKEN_TTL = 60 * 1000;

/**
 * Get the signing secret (derived from dashboard password + app secret for extra entropy).
 *
 * No defaults. The old `|| 'admin'` / `|| 'salt'` fallbacks meant that a deployment missing
 * either variable silently signed every session with a key that is published in this repo —
 * anyone could mint a valid session token from the source.
 */
function getSecret(): string {
    const password = process.env.DASHBOARD_PASSWORD;
    const appSecret = process.env.META_APP_SECRET;

    if (!password || !appSecret) {
        throw new Error('DASHBOARD_PASSWORD and META_APP_SECRET must both be set — sessions cannot be signed without them.');
    }
    return `${password}:${appSecret}`;
}

/**
 * What a session actually asserts.
 *
 * The old token payload was a bare timestamp — no identity at all. Every request was
 * "somebody who knew the one password", which is why ~13 call sites had to guess the tenant
 * with `SELECT ... WHERE is_active = true LIMIT 1`. Carrying the identity is what lets that
 * guess become a lookup.
 */
export interface SessionPayload {
    /** User row id. `null` for a legacy DASHBOARD_PASSWORD session (see createLegacySession). */
    userId: string | null;
    role: 'platform_admin' | 'user';
    /** The tenant this session is currently acting as. */
    tenantId: string | null;
    /** Mirrors users.token_version; bumping that column revokes every token a user holds. */
    tokenVersion: number;
    /** Issued-at, unix ms. */
    iat: number;
    /**
     * Absolute expiry, unix ms. Absent on an ordinary session, which then lives 24 hours from `iat` exactly as before.
     * Present only on a session issued for "keep me signed in" (`createSession`'s `ttlMs`), and carried over, never
     * extended, when a token is re-minted for the same sign-in (switching tenant, changing the password).
     */
    exp?: number;
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            session?: SessionPayload;
        }
    }
}

function sign(data: string): string {
    return crypto.createHmac('sha256', getSecret()).update(data).digest('hex');
}

/**
 * HMAC an arbitrary string with the session signing secret.
 *
 * Exported for the erasure preview token (src/services/erasure.ts), which needs a short-lived
 * signed claim that is not a session and not a download token. It signs rather than exporting
 * `getSecret()` so the secret itself never leaves this module — the same reason the download
 * token helpers live here instead of at their call site. Callers must namespace their own
 * payload (`erasure:v1:...`) so a token minted for one purpose cannot verify for another.
 */
export function signWithSessionSecret(data: string): string {
    return sign(data);
}

/**
 * Create a stateless signed token carrying who this is and which tenant they are acting as.
 *
 * `ttlMs` makes a longer-lived session ("keep me signed in for 30 days"): the token then carries its own `exp`,
 * clamped to `MAX_SESSION_TTL_MS`. A caller that is re-minting somebody's existing sign-in passes that session's `exp`
 * in the payload instead, so a switch of tenant never stretches a session that was already running out. Nothing passed
 * means the 24 hours every session had before, and the token is byte-for-byte what it always was.
 */
export function createSession(payload: Omit<SessionPayload, 'iat'>, options: { ttlMs?: number } = {}): string {
    const iat = Date.now();
    const { exp: carried, ...rest } = payload;
    const requested = options.ttlMs;
    const exp = typeof requested === 'number' && Number.isFinite(requested) && requested > SESSION_TTL
        ? iat + Math.min(requested, MAX_SESSION_TTL_MS)
        : carried;
    const body = Buffer.from(JSON.stringify({ ...rest, iat, ...(typeof exp === 'number' ? { exp } : {}) })).toString('base64url');
    return `${body}.${sign(body)}`;
}

/** What a token's lifetime reads as in a login response: `24h` for an ordinary session, whole days for a long one. */
export function describeSessionLifetime(ttlMs?: number): string {
    return typeof ttlMs === 'number' && ttlMs > SESSION_TTL ? `${Math.round(Math.min(ttlMs, MAX_SESSION_TTL_MS) / SESSION_TTL)}d` : '24h';
}

/**
 * A session for the pre-tenancy `DASHBOARD_PASSWORD` login.
 *
 * Kept deliberately: this is a live system, and removing the only way in before user accounts
 * exist would lock the operator out of their own dashboard. It resolves to platform_admin
 * against whichever creator is active, exactly matching the old behaviour.
 */
export function createLegacySession(tenantId: string | null): string {
    return createSession({ userId: null, role: 'platform_admin', tenantId, tokenVersion: 0 });
}

/** Verify a token and return its payload, or null. */
export function verifySession(token: string): SessionPayload | null {
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const body = parts[0]!;
    const signature = parts[1]!;

    let expected: string;
    try {
        expected = sign(body);
    } catch {
        return null; // signing secret unavailable — treat as unauthenticated, never as valid
    }

    try {
        if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
            return null;
        }
    } catch {
        return null; // malformed hex — Buffer.from silently truncates, so length must be checked by timingSafeEqual
    }

    let payload: SessionPayload;
    try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        return null;
    }

    if (typeof payload?.iat !== 'number') return null;
    // Reject future-dated tokens as well as expired ones. Not forgeable, but a clock skew
    // bug should not mint something that outlives the TTL.
    const now = Date.now();
    const age = now - payload.iat;
    if (age < -60_000) return null;

    if (payload.exp !== undefined) {
        // A session that asked to live longer says so itself, and the signature is what makes that claim trustworthy.
        // Still bounded: a malformed `exp`, or one further out than the cap, is not a session this file would issue.
        if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
        if (payload.exp - payload.iat > MAX_SESSION_TTL_MS) return null;
        if (now > payload.exp) return null;
    } else if (age > SESSION_TTL) {
        return null;
    }

    return payload;
}

/** Auth middleware — verifies the token and attaches the session. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;

    // `replace('Bearer ', '')` matched the first occurrence anywhere in the string, so a token
    // that happened to contain the literal text was mangled. Only a real prefix counts.
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    if (!token) {
        res.status(401).json({ error: 'Unauthorized — please login first.' });
        return;
    }

    const session = verifySession(token);
    if (!session) {
        res.status(401).json({ error: 'Session expired or invalid — please login again.' });
        return;
    }

    req.session = session;
    next();
}

// ─── One-shot download tokens ───────────────────────────────────────────────
//
// A browser navigation (`window.location.href = ...`) cannot carry an Authorization header,
// which is why the CSV export used to accept the 24h session token in the query string —
// straight into Vercel's access logs, the browser history and any Referer sent onwards.
//
// Instead the dashboard asks for a token that lives 60 seconds, is bound to the one path it
// may be spent on, and is burned on use.

/** Nonces already spent, with the expiry that makes them collectable. */
const spentDownloadNonces = new Map<string, number>();

function signDownloadToken(pathKey: string, expiresAt: number, nonce: string): string {
    return crypto
        .createHmac('sha256', getSecret())
        .update(`download:${pathKey}:${expiresAt}:${nonce}`)
        .digest('hex');
}

/** Mint a token that may be spent once, on `pathKey`, within the next minute. */
export function createDownloadToken(pathKey: string): string {
    const expiresAt = Date.now() + DOWNLOAD_TOKEN_TTL;
    const nonce = crypto.randomBytes(12).toString('hex');
    return `${expiresAt}.${nonce}.${signDownloadToken(pathKey, expiresAt, nonce)}`;
}

/**
 * Verify and burn a download token.
 *
 * The single-use half is best-effort: the spent-nonce set is per lambda instance, so a token
 * replayed against a different warm instance inside its 60-second window still passes. The
 * expiry is the guarantee here; burning it is what makes a leaked URL useless a second time
 * on the instance that saw it. A shared store would close the gap, and is the same store the
 * login throttle wants.
 */
export function consumeDownloadToken(token: unknown, pathKey: string): boolean {
    if (typeof token !== 'string') return false;

    const parts = token.split('.');
    if (parts.length !== 3) return false;

    const expiresAt = parseInt(parts[0]!, 10);
    const nonce = parts[1]!;
    const signature = parts[2]!;
    if (isNaN(expiresAt) || Date.now() > expiresAt) return false;

    const expected = signDownloadToken(pathKey, expiresAt, nonce);
    let signatureOk: boolean;
    try {
        signatureOk = crypto.timingSafeEqual(
            Buffer.from(signature, 'hex'),
            Buffer.from(expected, 'hex')
        );
    } catch {
        return false;
    }
    if (!signatureOk) return false;

    if (spentDownloadNonces.has(nonce)) return false;

    // Collect expired nonces on the way past so the map cannot grow without bound.
    const now = Date.now();
    for (const [seen, seenExpiry] of spentDownloadNonces) {
        if (seenExpiry < now) spentDownloadNonces.delete(seen);
    }
    spentDownloadNonces.set(nonce, expiresAt);

    return true;
}
