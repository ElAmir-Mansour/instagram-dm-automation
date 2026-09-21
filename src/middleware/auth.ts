import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Dashboard Authentication Middleware (Stateless)
 *
 * Uses HMAC-signed tokens instead of in-memory sessions so that
 * any Vercel serverless instance can independently verify the token
 * without needing shared state.
 *
 * Token format: <timestamp>.<hmac_signature>
 * - timestamp: when the token was created (unix ms)
 * - hmac_signature: HMAC-SHA256 of the timestamp, signed with DASHBOARD_PASSWORD
 */

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

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

/** Create a stateless signed token */
export function createSession(): string {
    const timestamp = Date.now().toString();
    const signature = crypto
        .createHmac('sha256', getSecret())
        .update(timestamp)
        .digest('hex');
    return `${timestamp}.${signature}`;
}

/** Verify a stateless signed token */
function verifyToken(token: string): boolean {
    const parts = token.split('.');
    if (parts.length !== 2) return false;

    const timestamp = parts[0]!;
    const signature = parts[1]!;
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts)) return false;

    // Check expiry
    if (Date.now() - ts > SESSION_TTL) return false;

    // Verify signature
    const expectedSignature = crypto
        .createHmac('sha256', getSecret())
        .update(timestamp)
        .digest('hex');

    try {
        return crypto.timingSafeEqual(
            Buffer.from(signature, 'hex'),
            Buffer.from(expectedSignature, 'hex')
        );
    } catch {
        return false;
    }
}

/** Auth middleware — verifies the stateless token */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;

    // `replace('Bearer ', '')` matched the first occurrence anywhere in the string, so a token
    // that happened to contain the literal text was mangled. Only a real prefix counts.
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    if (!token) {
        res.status(401).json({ error: 'Unauthorized — please login first.' });
        return;
    }

    if (!verifyToken(token)) {
        res.status(401).json({ error: 'Session expired or invalid — please login again.' });
        return;
    }

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
